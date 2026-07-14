import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export type SpamCheckResult = {
  spam: boolean;
  reason?: string;
};

const lastTextKey = (userId: string) => `spam:line:user:${userId}:last-text`;
const sameCountKey = (userId: string) => `spam:line:user:${userId}:same-count`;

const URL_PATTERN = /https?:\/\//gi;
const MAX_URLS_PER_MESSAGE = 3;
/** Stored last-text is capped so spam floods cannot bloat Redis. */
const STORED_TEXT_MAX_CHARS = 300;

/**
 * Lightweight, production-MVP spam detection:
 * - the same normalized text repeated SPAM_SAME_TEXT_LIMIT times within
 *   SPAM_SAME_TEXT_WINDOW_SEC is spam,
 * - messages longer than SPAM_MAX_MESSAGE_LENGTH are spam,
 * - messages stuffed with URLs are spam.
 * A spam verdict means: add a strike and silently drop the message.
 */
@Injectable()
export class SpamDetectorService {
  private readonly logger = new Logger(SpamDetectorService.name);

  private readonly sameTextLimit: number;
  private readonly sameTextWindowSec: number;
  private readonly spamMaxMessageLength: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.sameTextLimit = Number(
      configService.get('SPAM_SAME_TEXT_LIMIT') ?? 5,
    );
    this.sameTextWindowSec = Number(
      configService.get('SPAM_SAME_TEXT_WINDOW_SEC') ?? 30,
    );
    this.spamMaxMessageLength = Number(
      configService.get('SPAM_MAX_MESSAGE_LENGTH') ?? 3000,
    );
  }

  async check(userId: string, text: string): Promise<SpamCheckResult> {
    if (text.length > this.spamMaxMessageLength) {
      return {
        spam: true,
        reason: `message length ${text.length} exceeds ${this.spamMaxMessageLength}`,
      };
    }

    const urlCount = (text.match(URL_PATTERN) ?? []).length;
    if (urlCount > MAX_URLS_PER_MESSAGE) {
      return { spam: true, reason: `${urlCount} URLs in one message` };
    }

    return this.checkRepeatedText(userId, text);
  }

  private async checkRepeatedText(
    userId: string,
    text: string,
  ): Promise<SpamCheckResult> {
    const normalized = this.normalize(text);

    try {
      const lastText = await this.redis.get(lastTextKey(userId));

      if (lastText !== normalized) {
        await this.redis
          .pipeline()
          .set(lastTextKey(userId), normalized, 'EX', this.sameTextWindowSec)
          .set(sameCountKey(userId), 1, 'EX', this.sameTextWindowSec)
          .exec();
        return { spam: false };
      }

      const results = await this.redis
        .pipeline()
        .incr(sameCountKey(userId))
        .expire(sameCountKey(userId), this.sameTextWindowSec, 'NX')
        .exec();

      const sameCount = Number(results?.[0]?.[1] ?? 1);

      if (sameCount >= this.sameTextLimit) {
        return {
          spam: true,
          reason: `same text repeated ${sameCount} times within ${this.sameTextWindowSec}s`,
        };
      }

      return { spam: false };
    } catch (error) {
      // Fail open: spam detection must never block normal messages.
      this.logger.error(
        `spam check failed for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { spam: false };
    }
  }

  private normalize(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, STORED_TEXT_MAX_CHARS);
  }
}
