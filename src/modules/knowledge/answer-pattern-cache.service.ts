import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type {
  AnswerPattern,
  MicroKnowledge,
} from '../../generated/prisma/client';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { PrismaService } from '../../prisma/prisma.service';
import {
  knowledgeScope,
  KnowledgeScope,
} from '../../shared/knowledge/knowledge-scope';

/** Full records let a cache hit continue without another answer lookup. */
export type AnswerPatternCacheEntry = AnswerPattern;

/** Both lexical sources as loaded by one refresh. */
export type KnowledgeSnapshot = Readonly<{
  patterns: readonly AnswerPatternCacheEntry[];
  micro: readonly MicroKnowledge[];
}>;

const CACHE_TTL_MS = 240_000;
const MAX_CACHED_PATTERNS = 500;
/** Carries the sender's instance id so an instance ignores its own notice. */
const KNOWLEDGE_CHANGED_CHANNEL = 'knowledge:changed';

@Injectable()
export class AnswerPatternCacheService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AnswerPatternCacheService.name);

  private entries: AnswerPatternCacheEntry[] = [];
  private micro: MicroKnowledge[] = [];
  private loadedAt = 0;
  /** In-flight refresh; concurrent callers await this instead of re-querying. */
  private refreshing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;
  private capWarned = false;
  private readonly instanceId = randomUUID();

  private readonly scope: KnowledgeScope;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    // Optional so unit tests and scripts without Redis keep the TTL refresh.
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    this.scope = knowledgeScope(config);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), CACHE_TTL_MS);
    this.timer.unref?.();
    this.subscribe();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.subscriber?.disconnect();
  }

  getAll(): readonly AnswerPatternCacheEntry[] {
    if (Date.now() - this.loadedAt > CACHE_TTL_MS) {
      void this.refresh();
      return []; // Expired answers cannot take the zero-DB direct path.
    }
    return this.entries;
  }

  /**
   * Both sources while the snapshot is fresh; null when it expired or never
   * loaded, so the caller reads the database instead of trusting old rows.
   */
  snapshot(): KnowledgeSnapshot | null {
    if (Date.now() - this.loadedAt > CACHE_TTL_MS) {
      void this.refresh();
      return null;
    }
    return { patterns: this.entries, micro: this.micro };
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Call after a knowledge write commits. Loads a snapshot that started after
   * the write, then tells the other instances to do the same. Never throws:
   * a cache problem must not fail the admin's write.
   */
  async changed(): Promise<void> {
    await this.reload();
    try {
      await this.redis?.publish(KNOWLEDGE_CHANGED_CHANNEL, this.instanceId);
    } catch (error) {
      this.logger.warn(
        `[AnswerPatternCache] change notice not published; other instances refresh within ${CACHE_TTL_MS / 1000}s (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
  }

  /** A read already in flight may predate the write: wait it out, then read again. */
  private async reload(): Promise<void> {
    if (this.refreshing) await this.refreshing;
    await this.refresh();
  }

  /** Pub/sub is best effort; the TTL refresh covers a missed notice. */
  private subscribe(): void {
    if (!this.redis) return;
    try {
      const subscriber = this.redis.duplicate();
      subscriber.on('error', (error: unknown) =>
        this.logger.warn(
          `[AnswerPatternCache] subscriber error (${error instanceof Error ? error.name : 'unknown error'})`,
        ),
      );
      subscriber.on('message', (_channel: string, sender: string) => {
        if (sender !== this.instanceId) void this.reload();
      });
      // Not awaited: a slow Redis must not delay boot.
      void subscriber.subscribe(KNOWLEDGE_CHANGED_CHANNEL).catch(() => {
        this.logger.warn(
          '[AnswerPatternCache] subscribe failed; relying on the TTL refresh',
        );
      });
      this.subscriber = subscriber;
    } catch (error) {
      this.logger.warn(
        `[AnswerPatternCache] subscriber not started (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
  }

  private async doRefresh(): Promise<void> {
    const started = Date.now();
    try {
      const [rows, micro] = await Promise.all([
        this.prisma.answerPattern.findMany({
          where: { active: true, ...this.scope },
          orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
          take: MAX_CACHED_PATTERNS,
        }),
        this.prisma.microKnowledge.findMany({
          where: { active: true, ...this.scope },
          orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
          take: MAX_CACHED_PATTERNS,
        }),
      ]);

      this.entries = rows;
      this.micro = micro;
      this.loadedAt = Date.now();
      this.logger.debug(
        `[AnswerPatternCache] loaded ${rows.length} pattern(s) and ${micro.length} fact(s) in ${Date.now() - started}ms`,
      );
      this.warnAtCap(rows.length, micro.length);
    } catch (error) {
      // Keep serving the previous snapshot; the next tick retries.
      this.logger.error(
        `[AnswerPatternCache] refresh failed, keeping ${this.entries.length} cached entries`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Warns once when a source reaches the cap, and again only after it dropped below. */
  private warnAtCap(patterns: number, micro: number): void {
    const capped =
      patterns >= MAX_CACHED_PATTERNS || micro >= MAX_CACHED_PATTERNS;
    if (capped && !this.capWarned)
      this.logger.warn(
        `[AnswerPatternCache] row cap reached (patterns=${patterns}, micro=${micro}, cap=${MAX_CACHED_PATTERNS}): lower-priority knowledge is not searched lexically and DIRECT answers are off`,
      );
    this.capWarned = capped;
  }
}
