import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetInSec: number;
};

/**
 * Fixed-window rate limiter backed by Redis counters with TTL.
 *
 * The pipeline is INCRBY + EXPIRE NX + TTL: whichever concurrent caller
 * runs EXPIRE NX first sets the window, so a counter can never survive
 * without a TTL even across crashes or races.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(
    key: string,
    limit: number,
    windowSec: number,
    amount = 1,
  ): Promise<RateLimitResult> {
    try {
      const results = await this.redis
        .pipeline()
        .incrby(key, amount)
        .expire(key, windowSec, 'NX')
        .ttl(key)
        .exec();

      const current = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? windowSec);
      const resetInSec = ttl > 0 ? ttl : windowSec;

      return {
        allowed: current <= limit,
        current,
        limit,
        remaining: Math.max(0, limit - current),
        resetInSec,
      };
    } catch (error) {
      // Fail open: a Redis hiccup must not take the chatbot down with it.
      this.logger.error(
        `rate limit check failed for key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        allowed: true,
        current: 0,
        limit,
        remaining: limit,
        resetInSec: windowSec,
      };
    }
  }
}
