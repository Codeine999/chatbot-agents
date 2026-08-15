import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { AnswerPattern } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** Full records let a cache hit continue without another answer lookup. */
export type AnswerPatternCacheEntry = AnswerPattern;

const CACHE_TTL_MS = 240_000;
const MAX_CACHED_PATTERNS = 500;

@Injectable()
export class AnswerPatternCacheService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AnswerPatternCacheService.name);

  private entries: AnswerPatternCacheEntry[] = [];
  private loadedAt = 0;
  /** In-flight refresh; concurrent callers await this instead of re-querying. */
  private refreshing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), CACHE_TTL_MS);
    // Don't keep the process alive for the cache timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Current cached entries. Never hits the DB on the request path: if the
   * TTL has expired (e.g. the interval was starved), a background refresh is
   * kicked off and the stale snapshot is served meanwhile.
   */
  getAll(): readonly AnswerPatternCacheEntry[] {
    if (Date.now() - this.loadedAt > CACHE_TTL_MS) void this.refresh();
    return this.entries;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const started = Date.now();
    try {
      const rows = await this.prisma.answerPattern.findMany({
        where: { active: true },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        take: MAX_CACHED_PATTERNS,
      });

      this.entries = rows;
      this.loadedAt = Date.now();
      this.logger.debug(
        `[AnswerPatternCache] loaded ${rows.length} active pattern(s) in ${Date.now() - started}ms`,
      );
    } catch (error) {
      // Keep serving the previous snapshot; the next tick retries.
      this.logger.error(
        `[AnswerPatternCache] refresh failed, keeping ${this.entries.length} cached entries`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
