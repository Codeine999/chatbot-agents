import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ANALYTICS_INTERVALS = ['hour', 'day', 'month', 'year'] as const;

export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

/**
 * Ceiling on how many buckets one request may ask Postgres to emit, so an
 * `interval=hour` query over a decade cannot be used to hang the database.
 * At `hour` this allows roughly six weeks per request.
 */
export const MAX_ANALYTICS_BUCKETS = 1000;

/** Number of calendar years shown by the default yearly chart. */
export const DEFAULT_ANALYTICS_YEAR_SPAN = 5;

/**
 * Half-open UTC window the repository queries with: `[from, toExclusive)`.
 * `to` is a calendar day, so the caller's last day is included in full.
 */
export type AnalyticsRange = {
  interval: AnalyticsInterval;
  from: Date;
  toExclusive: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDay(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Supplies a useful chart window when the client selects only a granularity.
 * Explicit bounds always win, so custom date-range filtering still works.
 */
export function resolveAnalyticsQueryDefaults(
  query: Partial<{
    interval: AnalyticsInterval;
    from: string;
    to: string;
  }>,
  now = new Date(),
): { interval: AnalyticsInterval; from: string; to: string } {
  const interval = query.interval ?? 'day';
  const today = formatUtcDay(now);
  const year = now.getUTCFullYear();

  let defaultFrom: string;
  switch (interval) {
    case 'hour':
      // Hourly charts are intentionally limited to the current UTC day.
      defaultFrom = today;
      break;
    case 'day':
      defaultFrom = `${year}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
      break;
    case 'month':
      defaultFrom = `${year}-01-01`;
      break;
    case 'year':
      defaultFrom = `${year - DEFAULT_ANALYTICS_YEAR_SPAN + 1}-01-01`;
      break;
  }

  return {
    interval,
    from: query.from ?? defaultFrom,
    to: query.to ?? today,
  };
}

/** Midnight UTC of a `YYYY-MM-DD` string — the app stores every instant in UTC. */
function parseUtcDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

export function countAnalyticsBuckets(
  interval: AnalyticsInterval,
  from: string,
  to: string,
): number {
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);

  switch (interval) {
    case 'hour':
      return ((end.getTime() - start.getTime()) / DAY_MS) * 24 + 24;
    case 'day':
      return (end.getTime() - start.getTime()) / DAY_MS + 1;
    case 'month':
      return (
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        (end.getUTCMonth() - start.getUTCMonth()) +
        1
      );
    case 'year':
      return end.getUTCFullYear() - start.getUTCFullYear() + 1;
  }
}

/** Turns a validated query into the half-open UTC window the SQL runs on. */
export function toAnalyticsRange(query: {
  interval: AnalyticsInterval;
  from: string;
  to: string;
}): AnalyticsRange {
  return {
    interval: query.interval,
    from: parseUtcDay(query.from),
    toExclusive: new Date(parseUtcDay(query.to).getTime() + DAY_MS),
  };
}

/**
 * `from`/`to` stay strings rather than `z.coerce.date()`: a `Date` in a request
 * DTO cannot be represented in the OpenAPI document this app publishes at boot.
 * When absent, their defaults depend on the requested chart granularity:
 * hour=today, day=this month, month=this year, year=the last five years.
 */
export const getAdminAnalyticsQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    interval: z.enum(ANALYTICS_INTERVALS).default('day'),
  })
  .strict()
  .transform((query) => resolveAnalyticsQueryDefaults(query))
  .refine((query) => query.from <= query.to, {
    path: ['from'],
    message: 'from must be on or before to',
  })
  .refine(
    (query) =>
      countAnalyticsBuckets(query.interval, query.from, query.to) <=
      MAX_ANALYTICS_BUCKETS,
    {
      path: ['interval'],
      message: `Range is too wide for this interval (max ${MAX_ANALYTICS_BUCKETS} buckets)`,
    },
  );

export class GetAdminAnalyticsQueryDto extends createZodDto(
  getAdminAnalyticsQuerySchema,
) {}
