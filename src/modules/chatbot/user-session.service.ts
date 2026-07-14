import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';

export type ConversationFlow =
  | 'REGISTER'
  | 'GENERAL_QUESTION'
  | 'CHECK_STATUS'
  | 'CONTACT_ADMIN';

export type ConversationStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ConversationSession<TData = Record<string, unknown>> {
  userId: string;
  flow: ConversationFlow;
  step: string;
  status: ConversationStatus;
  data: TData;
}

const SESSION_KEY_PREFIX = 'chat:session:';
const DEFAULT_SESSION_TTL_SEC = 30 * 60;

@Injectable()
export class UserSessionService {
  private readonly logger = new Logger(UserSessionService.name);
  private readonly sessionTtlSec: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
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

    await this.redis.set(
      this.sessionKey(userId),
      JSON.stringify(session),
      'EX',
      this.sessionTtlSec,
    );
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
      session.data !== null &&
      typeof session.data === 'object' &&
      !Array.isArray(session.data)
    );
  }
}
