import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';
import type { AssistantAct } from '../../../shared/contracts/chat.types';
import { redactPii } from '../../../utils/text.utils';
import { readTurnUnderstandingConfig } from './turn-understanding.config';

const KEY_PREFIX = 'chat:turnmeta:';
const MAX_ASKED_CHARACTERS = 300;

const ACTS: readonly AssistantAct[] = [
  'ANSWERED',
  'ASKED',
  'GREETED',
  'ACKED',
  'HANDOFF_NOTICE',
  'FALLBACK',
  'GENERAL',
];

/**
 * What a room last did, small enough to live in one Redis hash. Every time is
 * the server's clock at the moment the thing was sent, so a comparison never
 * crosses machines. Assistant and admin write different fields and cannot
 * overwrite each other.
 */
export type TurnMeta = Readonly<{
  lastAct?: AssistantAct;
  lastActAt?: number;
  /** Only with lastAct ASKED: the assistant's own question, never the customer's text. */
  askedText?: string;
  lastAdminAt?: number;
  /** The last time the assistant told the customer that staff would come. */
  handoffNoticeAt?: number;
}>;

/** The assistant's question as kept in TurnMeta and shown to the classifier. */
export function askedTextOf(text: string): string {
  return Array.from(redactPii(text)).slice(0, MAX_ASKED_CHARACTERS).join('');
}

@Injectable()
export class TurnMetaStore {
  private readonly logger = new Logger(TurnMetaStore.name);
  private readonly ttlSec: number;
  /** Off means no reads and no writes: the deployment behaves as before. */
  readonly enabled: boolean;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    const settings = readTurnUnderstandingConfig(config);
    this.ttlSec = settings.turnMetaTtlSec;
    this.enabled = settings.phaticEnabled;
  }

  /** A Redis failure degrades to "nothing known", which routes as today. */
  async load(conversationId: string): Promise<TurnMeta> {
    if (!this.enabled || !conversationId) return {};

    try {
      return this.parse(await this.redis.hgetall(this.key(conversationId)));
    } catch (error) {
      this.warn('load', conversationId, error);
      return {};
    }
  }

  /** The assistant's reply was sent. */
  async markAssistant(
    conversationId: string,
    act: AssistantAct,
    askedText?: string,
  ): Promise<void> {
    if (!this.enabled || !conversationId) return;

    const key = this.key(conversationId);
    const now = String(Date.now());
    const fields: Record<string, string> = { lastAct: act, lastActAt: now };
    if (act === 'HANDOFF_NOTICE') fields.handoffNoticeAt = now;
    if (act === 'ASKED' && askedText) fields.askedText = askedText;

    try {
      const pipeline = this.redis.multi().hset(key, fields);
      if (act !== 'ASKED' || !askedText) pipeline.hdel(key, 'askedText');
      await this.run(pipeline.expire(key, this.ttlSec));
    } catch (error) {
      this.warn('markAssistant', conversationId, error);
    }
  }

  /**
   * Staff were requested without a reply being sent (a photo goes straight to
   * an admin), so no delivery will record it. Only the notice time is set:
   * the assistant did not say anything, so its last act stays as it was.
   */
  async markHandoffNotice(conversationId: string): Promise<void> {
    if (!this.enabled || !conversationId) return;

    const key = this.key(conversationId);
    try {
      await this.run(
        this.redis
          .multi()
          .hset(key, { handoffNoticeAt: String(Date.now()) })
          .expire(key, this.ttlSec),
      );
    } catch (error) {
      this.warn('markHandoffNotice', conversationId, error);
    }
  }

  /** An admin message was accepted by the platform. */
  async markAdmin(conversationId: string): Promise<void> {
    if (!this.enabled || !conversationId) return;

    const key = this.key(conversationId);
    try {
      await this.run(
        this.redis
          .multi()
          .hset(key, { lastAdminAt: String(Date.now()) })
          .expire(key, this.ttlSec),
      );
    } catch (error) {
      this.warn('markAdmin', conversationId, error);
    }
  }

  /** Resume-bot: the room starts over, like its chat context. */
  async clear(conversationId: string): Promise<void> {
    if (!this.enabled || !conversationId) return;

    try {
      await this.redis.del(this.key(conversationId));
    } catch (error) {
      this.warn('clear', conversationId, error);
    }
  }

  private key(conversationId: string): string {
    return `${KEY_PREFIX}${conversationId}`;
  }

  /** A command that fails inside MULTI does not throw; look for it. */
  private async run(pipeline: ReturnType<Redis['multi']>): Promise<void> {
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) throw failed[0];
  }

  private parse(raw: Record<string, string>): TurnMeta {
    const act = ACTS.find((value) => value === raw.lastAct);
    const time = (value: string | undefined) => {
      const parsed = Number(value);
      return value !== undefined && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : undefined;
    };

    return {
      ...(act ? { lastAct: act } : {}),
      ...(time(raw.lastActAt) ? { lastActAt: time(raw.lastActAt) } : {}),
      ...(raw.askedText ? { askedText: raw.askedText } : {}),
      ...(time(raw.lastAdminAt) ? { lastAdminAt: time(raw.lastAdminAt) } : {}),
      ...(time(raw.handoffNoticeAt)
        ? { handoffNoticeAt: time(raw.handoffNoticeAt) }
        : {}),
    };
  }

  private warn(action: string, conversationId: string, error: unknown): void {
    // Optional state: never fail a turn or a delivery over it.
    this.logger.warn(
      `turn meta ${action} failed conversation=${conversationId}: ${String(error)}`,
    );
  }
}
