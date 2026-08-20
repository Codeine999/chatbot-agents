import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import {
  ConversationSession,
  ConversationFlow,
  ConversationStatus,
} from './types/session.types';
import { NotificationService } from '../admin/notification/notification.service';

export type { ConversationSession } from './types/session.types';

const SESSION_KEY_PREFIX = 'chat:session:';
const DEFAULT_SESSION_TTL_SEC = 30 * 60;

@Injectable()
export class UserSessionService {
  private readonly logger = new Logger(UserSessionService.name);
  private readonly sessionTtlSec: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
    private readonly notificationService: NotificationService,
  ) {
    this.sessionTtlSec = this.positiveInteger(
      configService.get('CHAT_SESSION_TTL_SEC'),
      DEFAULT_SESSION_TTL_SEC,
    );
  }

  /**
   * Read a session and atomically refresh its expiry (sliding TTL).
   * Corrupt or mismatched values are deleted instead of entering a flow with
   * untrusted state.
   */
  async get(userId: string): Promise<ConversationSession | undefined> {
    const key = this.sessionKey(userId);
    const raw = await this.redis.getex(key, 'EX', this.sessionTtlSec);

    if (!raw) return undefined;

    try {
      const parsed: unknown = JSON.parse(raw);

      if (!this.isConversationSession(parsed) || parsed.userId !== userId) {
        throw new Error('invalid session shape or user mismatch');
      }

      return parsed;
    } catch (error) {
      this.logger.warn(
        `removing invalid chat session for user=${userId}: ${String(error)}`,
      );
      await this.redis.del(key);
      return undefined;
    }
  }

  async set<TData>(
    userId: string,
    session: ConversationSession<TData>,
  ): Promise<void> {
    if (session.userId !== userId) {
      throw new Error('Cannot store a chat session under a different user');
    }

    // Read before overwrite so a retried set() (e.g. after a failed LINE
    // reply, which BullMQ retries by re-running the whole event) can tell
    // "already flagged" from "just became flagged" and only notify once.
    const previous = session.requiAdmin ? await this.get(userId) : undefined;

    await this.redis.set(
      this.sessionKey(userId),
      JSON.stringify(session),
      'EX',
      this.sessionTtlSec,
    );

    if (session.requiAdmin && !previous?.requiAdmin) {
      // Best-effort: the session write already succeeded, so a notification
      // failure must not surface as a chat-flow error.
      try {
        await this.notificationService.notifyAdminRequired(session);
      } catch (error) {
        this.logger.warn(
          `failed to notify admins for user=${userId}: ${String(error)}`,
        );
      }
    }
  }

  async clear(userId: string): Promise<void> {
    await this.redis.del(this.sessionKey(userId));
  }

  private sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}${userId}`;
  }

  private positiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private isConversationSession(value: unknown): value is ConversationSession {
    if (!value || typeof value !== 'object') return false;

    const session = value as Record<string, unknown>;
    const flows: ConversationFlow[] = [
      'REGISTER',
      'GENERAL_QUESTION',
      'CHECK_STATUS',
      'CONTACT_ADMIN',
    ];
    const statuses: ConversationStatus[] = [
      'ACTIVE',
      'COMPLETED',
      'CANCELLED',
      'EXPIRED',
    ];

    return (
      typeof session.userId === 'string' &&
      flows.includes(session.flow as ConversationFlow) &&
      typeof session.step === 'string' &&
      statuses.includes(session.status as ConversationStatus) &&
      (session.requiAdmin === undefined ||
        typeof session.requiAdmin === 'boolean') &&
      session.data !== null &&
      typeof session.data === 'object' &&
      !Array.isArray(session.data)
    );
  }
}
