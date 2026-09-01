import { Injectable } from '@nestjs/common';
import { Prisma, UsageKind } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  AnalyticsInterval,
  AnalyticsRange,
} from './dto/get-admin-analytics-query.dto';

/**
 * `date_trunc` unit, `generate_series` step, and `to_char` label per interval.
 * All three are bound as parameters, never interpolated, so the keys are the
 * only thing the caller controls and they are already validated by the DTO.
 */
const BUCKET_UNIT: Record<AnalyticsInterval, string> = {
  hour: 'hour',
  day: 'day',
  month: 'month',
  year: 'year',
};

const BUCKET_STEP: Record<AnalyticsInterval, string> = {
  hour: '1 hour',
  day: '1 day',
  month: '1 month',
  year: '1 year',
};

/** Matches the granularity: `2026-09-01T13:00:00Z` / `2026-09-01` / `2026-09` / `2026`. */
const BUCKET_LABEL: Record<AnalyticsInterval, string> = {
  hour: 'YYYY-MM-DD"T"HH24:00:00"Z"',
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

export type ChatActivityRow = {
  timestamp: string;
  user: number;
  ai: number;
  admin: number;
  system: number;
  total: number;
};

export type CreditUsageRow = {
  timestamp: string;
  kind: UsageKind | null;
  events: number;
  chargedCredit: string;
  inputTokens: string;
  cachedInputTokens: string;
  cacheWriteTokens: string;
  outputTokens: string;
};

export type FollowerRow = {
  timestamp: string;
  snapshotDate: string | null;
  followerCount: number | null;
  targetedReaches: number | null;
  blockCount: number | null;
};

export type RevenueRow = {
  timestamp: string;
  amount: string;
  count: number;
};

@Injectable()
export class AdminAnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dense bucket spine. Every series LEFT JOINs it so a period with no rows
   * still comes back — the grouping happens in Postgres, and only one row per
   * bucket ever reaches Node.
   */
  private buckets(range: AnalyticsRange): Prisma.Sql {
    return Prisma.sql`
      SELECT generate_series(
        date_trunc(${BUCKET_UNIT[range.interval]}::text, ${range.from.toISOString()}::timestamp),
        date_trunc(${BUCKET_UNIT[range.interval]}::text, ${range.toExclusive.toISOString()}::timestamp - interval '1 microsecond'),
        ${BUCKET_STEP[range.interval]}::interval
      ) AS "bucketStart"
    `;
  }

  /**
   * Message counts per sender. Enum literals are the mapped database labels
   * (`LineChatSender` is `@map`ped to lowercase), not the Prisma client names.
   */
  async chatActivity(range: AnalyticsRange): Promise<ChatActivityRow[]> {
    return this.prisma.$queryRaw<ChatActivityRow[]>(Prisma.sql`
      WITH buckets AS (${this.buckets(range)}),
      counts AS (
        SELECT
          date_trunc(${BUCKET_UNIT[range.interval]}::text, "createdAt") AS "bucketStart",
          COUNT(*) FILTER (WHERE "sender" = 'user')   AS "user",
          COUNT(*) FILTER (WHERE "sender" = 'ai')     AS "ai",
          COUNT(*) FILTER (WHERE "sender" = 'admin')  AS "admin",
          COUNT(*) FILTER (WHERE "sender" = 'system') AS "system",
          COUNT(*)                                    AS "total"
        FROM "LineChatHistory"
        WHERE "createdAt" >= ${range.from.toISOString()}::timestamp
          AND "createdAt" <  ${range.toExclusive.toISOString()}::timestamp
        GROUP BY 1
      )
      SELECT
        to_char(buckets."bucketStart", ${BUCKET_LABEL[range.interval]}) AS "timestamp",
        COALESCE(counts."user", 0)::int   AS "user",
        COALESCE(counts."ai", 0)::int     AS "ai",
        COALESCE(counts."admin", 0)::int  AS "admin",
        COALESCE(counts."system", 0)::int AS "system",
        COALESCE(counts."total", 0)::int  AS "total"
      FROM buckets
      LEFT JOIN counts ON counts."bucketStart" = buckets."bucketStart"
      ORDER BY buckets."bucketStart"
    `);
  }

  /**
   * Usage per bucket in long form — one row per `UsageKind` that actually
   * billed, plus a `kind = NULL` row for buckets with no usage at all. The
   * service folds those into reporting categories; nothing is re-priced here,
   * `chargedCredit` is what `AiBillingService` already wrote.
   */
  async creditUsage(
    range: AnalyticsRange,
    companyId: string,
  ): Promise<CreditUsageRow[]> {
    return this.prisma.$queryRaw<CreditUsageRow[]>(Prisma.sql`
      WITH buckets AS (${this.buckets(range)}),
      usage AS (
        SELECT
          date_trunc(${BUCKET_UNIT[range.interval]}::text, "createdAt") AS "bucketStart",
          "kind",
          COUNT(*)::int                    AS "events",
          SUM("chargedCredit")::text       AS "chargedCredit",
          SUM("inputTokens")::text         AS "inputTokens",
          SUM("cachedInputTokens")::text   AS "cachedInputTokens",
          SUM("cacheWriteTokens")::text    AS "cacheWriteTokens",
          SUM("outputTokens")::text        AS "outputTokens"
        FROM "ai_usage_events"
        WHERE "companyId" = ${companyId}::uuid
          AND "createdAt" >= ${range.from.toISOString()}::timestamp
          AND "createdAt" <  ${range.toExclusive.toISOString()}::timestamp
        GROUP BY 1, 2
      )
      SELECT
        to_char(buckets."bucketStart", ${BUCKET_LABEL[range.interval]}) AS "timestamp",
        usage."kind"                                AS "kind",
        COALESCE(usage."events", 0)                 AS "events",
        COALESCE(usage."chargedCredit", '0')        AS "chargedCredit",
        COALESCE(usage."inputTokens", '0')          AS "inputTokens",
        COALESCE(usage."cachedInputTokens", '0')    AS "cachedInputTokens",
        COALESCE(usage."cacheWriteTokens", '0')     AS "cacheWriteTokens",
        COALESCE(usage."outputTokens", '0')         AS "outputTokens"
      FROM buckets
      LEFT JOIN usage ON usage."bucketStart" = buckets."bucketStart"
      ORDER BY buckets."bucketStart", usage."kind"
    `);
  }

  /**
   * Follower count is a level, not a sum, so each bucket takes the newest
   * snapshot inside it via `DISTINCT ON`. Buckets with no snapshot stay null
   * rather than being carried forward or zeroed.
   */
  async followers(range: AnalyticsRange): Promise<FollowerRow[]> {
    return this.prisma.$queryRaw<FollowerRow[]>(Prisma.sql`
      WITH buckets AS (${this.buckets(range)}),
      snapshots AS (
        SELECT
          date_trunc(${BUCKET_UNIT[range.interval]}::text, "date") AS "bucketStart",
          "date"            AS "snapshotDate",
          "followerCount",
          "targetedReaches",
          "blockCount"
        FROM "line_follower_snapshots"
        WHERE "date" >= ${range.from.toISOString()}::timestamp::date
          AND "date" <  ${range.toExclusive.toISOString()}::timestamp::date
      ),
      latest AS (
        -- Bucketed in the CTE above so DISTINCT ON and ORDER BY reference one
        -- expression; repeating date_trunc() here would bind a second
        -- placeholder and Postgres would reject them as different expressions.
        SELECT DISTINCT ON ("bucketStart") *
        FROM snapshots
        ORDER BY "bucketStart", "snapshotDate" DESC
      )
      SELECT
        to_char(buckets."bucketStart", ${BUCKET_LABEL[range.interval]}) AS "timestamp",
        to_char(latest."snapshotDate", 'YYYY-MM-DD')                    AS "snapshotDate",
        latest."followerCount",
        latest."targetedReaches",
        latest."blockCount"
      FROM buckets
      LEFT JOIN latest ON latest."bucketStart" = buckets."bucketStart"
      ORDER BY buckets."bucketStart"
    `);
  }

  /**
   * Newest snapshot strictly before the window, so the first bucket in the
   * series can still report growth.
   */
  async followerBaseline(range: AnalyticsRange) {
    return this.prisma.lineFollowerSnapshot.findFirst({
      where: { date: { lt: range.from } },
      orderBy: { date: 'desc' },
      select: { date: true, followerCount: true },
    });
  }

  async revenue(range: AnalyticsRange): Promise<RevenueRow[]> {
    return this.prisma.$queryRaw<RevenueRow[]>(Prisma.sql`
      WITH buckets AS (${this.buckets(range)}),
      paid AS (
        SELECT
          date_trunc(${BUCKET_UNIT[range.interval]}::text, "createdAt") AS "bucketStart",
          SUM("payAmount") AS "amount",
          COUNT(*)         AS "count"
        FROM "UserPayment"
        WHERE "status" = 'success'
          AND "createdAt" >= ${range.from.toISOString()}::timestamp
          AND "createdAt" <  ${range.toExclusive.toISOString()}::timestamp
        GROUP BY 1
      )
      SELECT
        to_char(buckets."bucketStart", ${BUCKET_LABEL[range.interval]}) AS "timestamp",
        COALESCE(paid."amount", 0)::text AS "amount",
        COALESCE(paid."count", 0)::int   AS "count"
      FROM buckets
      LEFT JOIN paid ON paid."bucketStart" = buckets."bucketStart"
      ORDER BY buckets."bucketStart"
    `);
  }
}
