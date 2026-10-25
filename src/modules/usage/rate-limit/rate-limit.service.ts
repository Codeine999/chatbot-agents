import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetInSec: number;
  /** True only when Redis could not be reached, so `allowed` is a fallback, not a verdict. */
  unavailable?: boolean;
};

export type RateLimitOptions = {
  /** When Redis is unreachable: true (default) allows the call, false denies it. */
  failOpen?: boolean;
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
    options: RateLimitOptions = {},
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
      // Fail open by default: a Redis hiccup must not take the chatbot down
      // with it. Public endpoints opt into `failOpen: false` so an outage
      // cannot silently remove their protection.
      const failOpen = options.failOpen ?? true;
      this.logger.error(
        `rate limit check failed for key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        allowed: failOpen,
        current: 0,
        limit,
        remaining: failOpen ? limit : 0,
        resetInSec: windowSec,
        unavailable: true,
      };
    }
  }
}
