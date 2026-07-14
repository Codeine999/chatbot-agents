import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export type BanInfo = {
  banned: boolean;
  permanent: boolean;
  reason?: string;
  expiresInSec?: number;
};

export type StrikeResult = {
  strikes: number;
  banned: boolean;
  banDurationSec?: number;
};

const banKey = (userId: string) => `ban:line:user:${userId}`;
const strikesKey = (userId: string) => `strikes:line:user:${userId}`;

/**
 * Redis-backed strike counter and ban state for LINE users.
 *
 * Escalation: strikes 1-2 are recorded only, strike 3 bans for
 * ABUSE_BAN_1_SEC, strike 4 for ABUSE_BAN_2_SEC, strike 5+ for
 * ABUSE_BAN_3_SEC. Permanent bans are set manually and never expire.
 * Bans are silent: banned users' messages are dropped without a reply.
 */
@Injectable()
export class BanService {
  private readonly logger = new Logger(BanService.name);

  private readonly strikeWindowSec: number;
  private readonly ban1Sec: number;
  private readonly ban2Sec: number;
  private readonly ban3Sec: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.strikeWindowSec = Number(
      configService.get('ABUSE_STRIKE_WINDOW_SEC') ?? 86400,
    );
    this.ban1Sec = Number(configService.get('ABUSE_BAN_1_SEC') ?? 300);
    this.ban2Sec = Number(configService.get('ABUSE_BAN_2_SEC') ?? 3600);
    this.ban3Sec = Number(configService.get('ABUSE_BAN_3_SEC') ?? 86400);
  }

  async isBanned(userId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(banKey(userId))) === 1;
    } catch (error) {
      this.logger.error(
        `ban check failed for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  async getBanInfo(userId: string): Promise<BanInfo> {
    const [raw, ttl] = await Promise.all([
      this.redis.get(banKey(userId)),
      this.redis.ttl(banKey(userId)),
    ]);

    if (!raw) {
      return { banned: false, permanent: false };
    }

    let reason: string | undefined;
    let permanent = ttl === -1;
    try {
      const parsed = JSON.parse(raw) as { reason?: string; permanent?: boolean };
      reason = parsed.reason;
      permanent = parsed.permanent ?? permanent;
    } catch {
      reason = raw;
    }

    return {
      banned: true,
      permanent,
      reason,
      expiresInSec: ttl > 0 ? ttl : undefined,
    };
  }

  async addStrike(userId: string, reason: string): Promise<StrikeResult> {
    try {
      const results = await this.redis
        .pipeline()
        .incr(strikesKey(userId))
        .expire(strikesKey(userId), this.strikeWindowSec, 'NX')
        .exec();

      const strikes = Number(results?.[0]?.[1] ?? 0);
      this.logger.warn(`strike ${strikes} for user ${userId}: ${reason}`);

      const banDurationSec = this.banDurationForStrikes(strikes);

      if (banDurationSec === undefined) {
        return { strikes, banned: false };
      }

      await this.banTemporarily(
        userId,
        banDurationSec,
        `strike ${strikes}: ${reason}`,
      );

      return { strikes, banned: true, banDurationSec };
    } catch (error) {
      this.logger.error(
        `addStrike failed for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { strikes: 0, banned: false };
    }
  }

  async banTemporarily(
    userId: string,
    durationSec: number,
    reason: string,
  ): Promise<void> {
    await this.redis.set(
      banKey(userId),
      JSON.stringify({ reason, permanent: false, bannedAt: Date.now() }),
      'EX',
      durationSec,
    );
    this.logger.warn(
      `user ${userId} temporarily banned for ${durationSec}s: ${reason}`,
    );
  }

  async banPermanently(userId: string, reason: string): Promise<void> {
    await this.redis.set(
      banKey(userId),
      JSON.stringify({ reason, permanent: true, bannedAt: Date.now() }),
    );
    this.logger.warn(`user ${userId} permanently banned: ${reason}`);
  }

  async clearBan(userId: string): Promise<void> {
    await this.redis.del(banKey(userId), strikesKey(userId));
    this.logger.log(`ban and strikes cleared for user ${userId}`);
  }

  private banDurationForStrikes(strikes: number): number | undefined {
    if (strikes >= 5) return this.ban3Sec;
    if (strikes === 4) return this.ban2Sec;
    if (strikes === 3) return this.ban1Sec;
    return undefined;
  }
}
