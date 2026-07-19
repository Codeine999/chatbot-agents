import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infra/redis/redis.module';
import {
  ChatContextMessage,
  ChatResponse,
  ChatResponseSource,
} from '../types/chat.types';

const CONTEXT_KEY_PREFIX = 'chat:context:';
const CONTEXT_TTL_SEC = 30 * 60;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_TURNS = MAX_CONTEXT_MESSAGES / 2;
const MAX_STORED_MESSAGE_CHARACTERS = 4_000;

type StoredChatTurn = {
  version: 1;
  eventId: string;
  createdAt: number;
  userText: string;
  assistantText: string;
  assistantSource: ChatResponseSource;
};

export type AppendContextTurnParams = Readonly<{
  conversationId: string;
  eventId: string;
  userText: string;
  response: ChatResponse;
  createdAt?: number;
}>;

@Injectable()
export class LoadContextService {
  private readonly logger = new Logger(LoadContextService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Loads at most six previously delivered messages in chronological order.
   * Reading does not extend the TTL; only a successfully delivered new turn
   * starts another 30-minute context window.
   */
  async load(conversationId: string): Promise<ChatContextMessage[]> {
    if (!conversationId) return [];

    try {
      const values = await this.redis.lrange(
        this.contextKey(conversationId),
        -MAX_CONTEXT_TURNS,
        -1,
      );

      const messages: ChatContextMessage[] = [];

      for (const value of values) {
        const turn = this.parseTurn(value);
        if (!turn) continue;

        messages.push(
          {
            role: 'user',
            text: turn.userText,
            source: 'USER',
            createdAt: turn.createdAt,
          },
          {
            role: 'assistant',
            text: turn.assistantText,
            source: turn.assistantSource,
            createdAt: turn.createdAt,
          },
        );
      }

      return messages.slice(-MAX_CONTEXT_MESSAGES);
    } catch (error) {
      // Context is an optional cache. Redis trouble must not stop a LINE reply.
      this.logger.warn(
        `failed to load chat context for conversation=${conversationId}: ${String(error)}`,
      );
      return [];
    }
  }

  /**
   * Stores one complete delivered turn atomically, keeps only three turns
   * (six role messages), and applies a sliding 30-minute TTL.
   */
  async appendTurn(params: AppendContextTurnParams): Promise<boolean> {
    const { conversationId, eventId, response } = params;
    const userText = this.prepareText(params.userText);
    const assistantText = this.prepareText(response.text);

    if (
      response.contextPolicy !== 'INCLUDE' ||
      !conversationId ||
      !eventId ||
      !userText ||
      !assistantText
    ) {
      return false;
    }

    const turn: StoredChatTurn = {
      version: 1,
      eventId,
      createdAt: params.createdAt ?? Date.now(),
      userText,
      assistantText,
      assistantSource: response.source,
    };

    const key = this.contextKey(conversationId);

    try {
      const result = await this.redis
        .multi()
        .rpush(key, JSON.stringify(turn))
        .ltrim(key, -MAX_CONTEXT_TURNS, -1)
        .expire(key, CONTEXT_TTL_SEC)
        .exec();

      if (!result || result.some(([error]) => error !== null)) {
        throw new Error('Redis transaction did not complete successfully');
      }

      return true;
    } catch (error) {
      // The LINE reply has already been delivered at this point. Never throw,
      // because retrying the webhook could send the same reply twice.
      this.logger.warn(
        `failed to append chat context for conversation=${conversationId}: ${String(error)}`,
      );
      return false;
    }
  }

  async clear(conversationId: string): Promise<boolean> {
    if (!conversationId) return false;

    try {
      await this.redis.del(this.contextKey(conversationId));
      return true;
    } catch (error) {
      this.logger.warn(
        `failed to clear chat context for conversation=${conversationId}: ${String(error)}`,
      );
      return false;
    }
  }

  private contextKey(conversationId: string): string {
    return `${CONTEXT_KEY_PREFIX}${conversationId}`;
  }

  private prepareText(value: string): string {
    const redacted = value
      .replace(
        /((?:รหัสผ่าน|password|passcode)\s*[:=]?\s*)\S+/giu,
        '$1[REDACTED_PASSWORD]',
      )
      .replace(
        /((?:เลขบัญชี|บัญชีธนาคาร|bank\s*account|account\s*number)\s*[:=]?\s*)\d(?:[\d -]{7,18}\d)?/giu,
        '$1[REDACTED_ACCOUNT]',
      )
      .replace(/(?:\+66|0)(?:[\s-]?\d){8,9}/g, '[REDACTED_PHONE]')
      .trim();

    return Array.from(redacted)
      .slice(0, MAX_STORED_MESSAGE_CHARACTERS)
      .join('');
  }

  private parseTurn(value: string): StoredChatTurn | null {
    try {
      const parsed: unknown = JSON.parse(value);

      if (!this.isStoredChatTurn(parsed)) {
        throw new Error('invalid stored turn');
      }

      return parsed;
    } catch (error) {
      this.logger.warn(
        `ignoring invalid Redis chat context turn: ${String(error)}`,
      );
      return null;
    }
  }

  private isStoredChatTurn(value: unknown): value is StoredChatTurn {
    if (!value || typeof value !== 'object') return false;

    const turn = value as Partial<StoredChatTurn>;

    return (
      turn.version === 1 &&
      typeof turn.eventId === 'string' &&
      turn.eventId.length > 0 &&
      typeof turn.createdAt === 'number' &&
      Number.isFinite(turn.createdAt) &&
      typeof turn.userText === 'string' &&
      turn.userText.trim().length > 0 &&
      typeof turn.assistantText === 'string' &&
      turn.assistantText.trim().length > 0 &&
      this.isChatResponseSource(turn.assistantSource)
    );
  }

  private isChatResponseSource(value: unknown): value is ChatResponseSource {
    return (
      value === 'SYSTEM' ||
      value === 'RULE' ||
      value === 'KNOWLEDGE' ||
      value === 'AI' ||
      value === 'REGISTRATION'
    );
  }
}
