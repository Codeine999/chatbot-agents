import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';

/**
 * Budget gate for every external AI (Gemini) call: a global per-second
 * limit plus a per-user hourly limit. Callers that are over budget must
 * skip the AI call and use their non-AI fallback path.
 */
@Injectable()
export class AiBudgetService {
  private readonly logger = new Logger(AiBudgetService.name);

  private readonly globalLimitPerSec: number;
  private readonly userLimitPerHour: number;

  constructor(
    private readonly rateLimitService: RateLimitService,
    configService: ConfigService,
  ) {
    this.globalLimitPerSec = Number(
      configService.get('AI_GLOBAL_LIMIT_PER_SEC') ?? 30,
    );
    this.userLimitPerHour = Number(
      configService.get('AI_USER_LIMIT_PER_HOUR') ?? 60,
    );
  }

  /** Returns true when the AI call may proceed. Consumes budget on success. */
  async tryConsume(userId?: string): Promise<boolean> {
    const global = await this.rateLimitService.consume(
      'rl:ai:global',
      this.globalLimitPerSec,
      1,
    );

    if (!global.allowed) {
      this.logger.warn(
        `AI budget exceeded (global): ${global.current}/${global.limit} per sec`,
      );
      return false;
    }

    if (!userId) {
      return true;
    }

    const user = await this.rateLimitService.consume(
      `rl:ai:user:${userId}`,
      this.userLimitPerHour,
      3600,
    );

    if (!user.allowed) {
      this.logger.warn(
        `AI budget exceeded (user ${userId}): ${user.current}/${user.limit} per hour`,
      );
      return false;
    }

    return true;
  }
}
