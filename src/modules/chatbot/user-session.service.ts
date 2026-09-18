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
import { PrismaService } from '../../prisma/prisma.service';

export type { ConversationSession } from './types/session.types';

const SESSION_KEY_PREFIX = 'chat:session:';
const DEFAULT_SESSION_TTL_SEC = 30 * 60;

@Injectable()
export class UserSessionService {
  private readonly logger = new Logger(UserSessionService.name);
  private readonly sessionTtlSec: number;
  private readonly muteTtlSec: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService,
  ) {
    this.sessionTtlSec = this.positiveInteger(
      configService.get('CHAT_SESSION_TTL_SEC'),
      DEFAULT_SESSION_TTL_SEC,
    );
    const duration = String(configService.get('AUTO_MUTE_WHEN_REPLY') ?? '10m');
    const match = /^(\d+)(s|m)?$/.exec(duration.trim());
    if (!match || Number(match[1]) < 1) {
      throw new Error(
        'AUTO_MUTE_WHEN_REPLY must be positive seconds or a duration such as 10m',
      );
    }
    this.muteTtlSec = Number(match[1]) * (match[2] === 'm' ? 60 : 1);
  }

  /**
   * Read the workflow session and atomically refresh its expiry (sliding TTL).
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

      return this.toWorkflow(parsed);
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
      JSON.stringify(this.toWorkflow(session)),
      'EX',
      this.sessionTtlSec,
    );
  }

  async isMuted(userId: string): Promise<boolean> {
    const mode = await this.redis.get(this.muteKey(userId));
    return mode === 'ADMIN' || mode === 'PAUSE';
  }

  /** SET EX resets the full TTL on every push; it never accumulates. */
  async mute(userId: string, mode: 'ADMIN' | 'PAUSE' = 'ADMIN'): Promise<void> {
    await this.redis.set(this.muteKey(userId), mode, 'EX', this.muteTtlSec);
  }

  async resume(userId: string): Promise<void> {
    await this.redis.del(this.muteKey(userId));
  }

  async requestAdmin(userId: string): Promise<void> {
    const changed = await this.prisma.lineConversation.updateMany({
      where: {
        lineMember: { lineUserId: userId },
        status: { not: 'waiting_admin' },
      },
      data: { status: 'waiting_admin' },
    });
    if (changed.count > 0) {
      try {
        const workflow = await this.get(userId);
        await this.notificationService.notifyAdminRequired({
          userId,
          flow: workflow?.flow ?? 'CONTACT_ADMIN',
          step: workflow?.step ?? 'WAITING_ADMIN',
          status: workflow?.status ?? 'ACTIVE',
        });
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

  private muteKey(userId: string): string {
    return `chat:control:${userId}`;
  }

  private sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}${userId}`;
  }

  /** Drops legacy fields (controlMode, requiAdmin) left in older Redis values. */
  private toWorkflow<TData>(
    session: ConversationSession<TData>,
  ): ConversationSession<TData> {
    const { userId, flow, step, status, data } = session;
    return { userId, flow, step, status, data };
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
