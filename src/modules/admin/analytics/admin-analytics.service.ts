import { Injectable } from '@nestjs/common';
import { Prisma, UsageKind } from '../../../generated/prisma/client';
import { CompanyService } from '../company/company.service';
import {
  AdminAnalyticsRepository,
  type CreditUsageRow,
  type FollowerRow,
} from './admin-analytics.repository';
import {
  toAnalyticsRange,
  type AnalyticsRange,
  type GetAdminAnalyticsQueryDto,
} from './dto/get-admin-analytics-query.dto';

/**
 * Reporting buckets the dashboard charts. `UsageKind` is the billing enum and
 * stays the source of truth; this only decides which bucket each kind is shown
 * under. Typed as a total record so a new `UsageKind` fails the build here
 * instead of silently vanishing from the report.
 */
const CREDIT_CATEGORY_BY_KIND: Record<UsageKind, CreditCategory> = {
  [UsageKind.LINE_PUSH_MESSAGE]: 'lineMessage',
  [UsageKind.LINE_AI_REPLY]: 'aiUsage',
  [UsageKind.EMBEDDING]: 'aiUsage',
  [UsageKind.ADMIN_AI_QUERY]: 'adminAiQuery',
};

const CREDIT_CATEGORIES = ['lineMessage', 'aiUsage', 'adminAiQuery'] as const;

type CreditCategory = (typeof CREDIT_CATEGORIES)[number];

type CreditTotals = {
  events: number;
  chargedCredit: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type CreditAccumulator = {
  events: number;
  chargedCredit: Prisma.Decimal;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly repository: AdminAnalyticsRepository,
    private readonly companyService: CompanyService,
  ) {}

  async getChatActivity(query: GetAdminAnalyticsQueryDto) {
    const range = toAnalyticsRange(query);
    const series = await this.repository.chatActivity(range);

    return {
      range: this.describeRange(query, range),
      totals: series.reduce(
        (totals, bucket) => ({
          user: totals.user + bucket.user,
          ai: totals.ai + bucket.ai,
          admin: totals.admin + bucket.admin,
          system: totals.system + bucket.system,
          total: totals.total + bucket.total,
        }),
        { user: 0, ai: 0, admin: 0, system: 0, total: 0 },
      ),
      series,
    };
  }

  async getCreditUsage(query: GetAdminAnalyticsQueryDto) {
    const range = toAnalyticsRange(query);
    const companyId = await this.companyService.getCompanyId();
    const rows = await this.repository.creditUsage(range, companyId);

    const buckets = new Map<
      string,
      Record<CreditCategory | 'total', CreditAccumulator>
    >();

    for (const row of rows) {
      const bucket =
        buckets.get(row.timestamp) ??
        this.emptyCreditBucket(buckets, row.timestamp);

      // A bucket with no usage arrives once with kind = NULL; it only needs the
      // zeroed accumulators the line above already created.
      if (!row.kind) continue;

      this.addUsage(bucket[CREDIT_CATEGORY_BY_KIND[row.kind]], row);
      this.addUsage(bucket.total, row);
    }

    const series = [...buckets].map(([timestamp, bucket]) => ({
      timestamp,
      lineMessage: this.finalizeCredit(bucket.lineMessage),
      aiUsage: this.finalizeCredit(bucket.aiUsage),
      adminAiQuery: this.finalizeCredit(bucket.adminAiQuery),
      total: this.finalizeCredit(bucket.total),
    }));

    return {
      range: this.describeRange(query, range),
      /** Which `UsageKind`s each reported category is made of. */
      categories: CREDIT_CATEGORIES.reduce<Record<CreditCategory, UsageKind[]>>(
        (map, category) => {
          map[category] = (
            Object.keys(CREDIT_CATEGORY_BY_KIND) as UsageKind[]
          ).filter((kind) => CREDIT_CATEGORY_BY_KIND[kind] === category);
          return map;
        },
        {} as Record<CreditCategory, UsageKind[]>,
      ),
      totals: this.finalizeCredit(
        series.reduce((totals, bucket) => {
          this.addUsage(totals, {
            events: bucket.total.events,
            chargedCredit: bucket.total.chargedCredit,
            inputTokens: String(bucket.total.inputTokens),
            cachedInputTokens: String(bucket.total.cachedInputTokens),
            cacheWriteTokens: String(bucket.total.cacheWriteTokens),
            outputTokens: String(bucket.total.outputTokens),
          });
          return totals;
        }, this.emptyAccumulator()),
      ),
      series,
    };
  }

  async getFollowers(query: GetAdminAnalyticsQueryDto) {
    const range = toAnalyticsRange(query);
    const [rows, baseline] = await Promise.all([
      this.repository.followers(range),
      this.repository.followerBaseline(range),
    ]);

    // Growth is measured against the last bucket that actually held a snapshot,
    // so gaps in the daily capture do not read as a drop to zero.
    let previous = baseline?.followerCount ?? null;
    const series = rows.map((row) => {
      const growth = this.growthFrom(previous, row);
      if (row.followerCount !== null) previous = row.followerCount;
      return { ...row, ...growth };
    });

    const observed = series.filter((bucket) => bucket.followerCount !== null);
    const first = observed.at(0)?.followerCount ?? null;
    const last = observed.at(-1)?.followerCount ?? null;
    const from = baseline?.followerCount ?? first;

    return {
      range: this.describeRange(query, range),
      baseline: baseline
        ? {
            date: baseline.date.toISOString().slice(0, 10),
            followerCount: baseline.followerCount,
          }
        : null,
      summary: {
        first,
        last,
        growth: from !== null && last !== null ? last - from : null,
        growthPercent: this.percent(from, last),
      },
      series,
    };
  }

  async getRevenue(query: GetAdminAnalyticsQueryDto) {
    const range = toAnalyticsRange(query);
    const rows = await this.repository.revenue(range);

    // Summed as Decimal, and re-emitted through it so a bucket and the total
    // are formatted the same way rather than carrying the column's scale.
    const total = rows.reduce(
      (sum, bucket) => sum.plus(bucket.amount),
      new Prisma.Decimal(0),
    );

    return {
      range: this.describeRange(query, range),
      totals: {
        amount: total.toString(),
        count: rows.reduce((sum, bucket) => sum + bucket.count, 0),
      },
      series: rows.map((bucket) => ({
        ...bucket,
        amount: new Prisma.Decimal(bucket.amount).toString(),
      })),
    };
  }

  /** Echoes the window back, and states the timezone every bucket is cut in. */
  private describeRange(
    query: GetAdminAnalyticsQueryDto,
    range: AnalyticsRange,
  ) {
    return {
      from: query.from,
      to: query.to,
      interval: range.interval,
      timezone: 'UTC',
    };
  }

  private emptyAccumulator(): CreditAccumulator {
    return {
      events: 0,
      chargedCredit: new Prisma.Decimal(0),
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
  }

  private emptyCreditBucket(
    buckets: Map<string, Record<CreditCategory | 'total', CreditAccumulator>>,
    timestamp: string,
  ) {
    const bucket = {
      lineMessage: this.emptyAccumulator(),
      aiUsage: this.emptyAccumulator(),
      adminAiQuery: this.emptyAccumulator(),
      total: this.emptyAccumulator(),
    };
    buckets.set(timestamp, bucket);
    return bucket;
  }

  private addUsage(
    target: CreditAccumulator,
    row: Omit<CreditUsageRow, 'timestamp' | 'kind'>,
  ): void {
    target.events += row.events;
    target.chargedCredit = target.chargedCredit.plus(row.chargedCredit);
    target.inputTokens += Number(row.inputTokens);
    target.cachedInputTokens += Number(row.cachedInputTokens);
    target.cacheWriteTokens += Number(row.cacheWriteTokens);
    target.outputTokens += Number(row.outputTokens);
  }

  private finalizeCredit(accumulator: CreditAccumulator): CreditTotals {
    return {
      events: accumulator.events,
      chargedCredit: accumulator.chargedCredit.toString(),
      inputTokens: accumulator.inputTokens,
      cachedInputTokens: accumulator.cachedInputTokens,
      cacheWriteTokens: accumulator.cacheWriteTokens,
      outputTokens: accumulator.outputTokens,
      totalTokens:
        accumulator.inputTokens +
        accumulator.cachedInputTokens +
        accumulator.cacheWriteTokens +
        accumulator.outputTokens,
    };
  }

  private growthFrom(previous: number | null, row: FollowerRow) {
    if (previous === null || row.followerCount === null) {
      return { growth: null, growthPercent: null };
    }

    return {
      growth: row.followerCount - previous,
      growthPercent: this.percent(previous, row.followerCount),
    };
  }

  /** One decimal place, matching `CompanyService.getFollowerChange`. */
  private percent(from: number | null, to: number | null): number | null {
    if (from === null || to === null || from === 0) return null;
    return Math.round(((to - from) / from) * 1000) / 10;
  }
}
