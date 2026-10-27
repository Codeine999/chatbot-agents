import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';

/**
 * Per-user Redis state only: bans, strikes, spam counters, rate-limit
 * counters and chat sessions (workflow session, bot mute, dashboard preview
 * sessions). Global caps (`rl:ai:global`, `rl:line:global:*`,
 * `rl:app:msg:total:day`) and BullMQ queues are not listed here on purpose,
 * so a reset can never reach them.
 */
export const USER_LIMIT_KEY_GROUPS = {
  bans: ['ban:line:user:*'],
  strikes: ['strikes:line:user:*'],
  spam: ['spam:line:user:*'],
  lineLimits: ['rl:line:user:*'],
  aiLimits: ['rl:ai:user:*'],
  appLimits: [
    'rl:app:authfail:*',
    'rl:app:sess:ip:*',
    'rl:app:msg:c:*',
    'rl:app:msg:ip:*',
    'rl:app:read:ip:*',
  ],
  sessions: ['chat:session:*', 'chat:control:*', 'preview:session:*'],
} as const;

export type UserLimitResetResult = Record<
  keyof typeof USER_LIMIT_KEY_GROUPS,
  number
>;

const SCAN_COUNT = 500;

@Injectable()
export class UserLimitResetService {
  private readonly logger = new Logger(UserLimitResetService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Clears every user's ban, strikes, spam, limit counters and sessions. */
  async clearAll(adminId: string): Promise<UserLimitResetResult> {
    const result = {} as UserLimitResetResult;

    for (const [group, patterns] of Object.entries(USER_LIMIT_KEY_GROUPS)) {
      let removed = 0;
      for (const pattern of patterns) {
        removed += await this.removeMatching(pattern);
      }
      result[group as keyof UserLimitResetResult] = removed;
    }

    this.logger.warn(
      `user limits cleared by admin ${adminId}: ${JSON.stringify(result)}`,
    );
    return result;
  }

  /** SCAN (never KEYS) so a large keyspace does not block Redis. */
  private async removeMatching(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        SCAN_COUNT,
      );
      cursor = next;
      if (keys.length > 0) removed += await this.redis.unlink(...keys);
    } while (cursor !== '0');
    return removed;
  }
}
