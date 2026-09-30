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
 * Timezone every bucket is cut in. The business and the dashboard both run on
 * Thai time, and the dashboard builds its axis in local time; cutting in UTC
 * pushed everything between 00:00 and 07:00 onto the previous day.
 */
export const ANALYTICS_TIMEZONE = 'Asia/Bangkok';

/**
 * Half-open window of calendar days in `timeZone`: `[from, toExclusive)`.
 * `to` is a calendar day, so the caller's last day is included in full. The
 * repository converts these to UTC instants, which is how rows are stored.
 */
export type AnalyticsRange = {
  interval: AnalyticsInterval;
  from: string;
  toExclusive: string;
  timeZone: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDay(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Calendar day of an instant in the reporting timezone, as `YYYY-MM-DD`. */
function formatReportingDay(date: Date): string {
  // en-CA formats as ISO `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ANALYTICS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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
  const today = formatReportingDay(now);
  const year = Number(today.slice(0, 4));

  let defaultFrom: string;
  switch (interval) {
    case 'hour':
      // Hourly charts are intentionally limited to the current day.
      defaultFrom = today;
      break;
    case 'day':
      defaultFrom = `${today.slice(0, 7)}-01`;
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

/** A `YYYY-MM-DD` string as a UTC Date, used only for calendar arithmetic. */
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

/** Turns a validated query into the half-open day window the SQL runs on. */
export function toAnalyticsRange(query: {
  interval: AnalyticsInterval;
  from: string;
  to: string;
}): AnalyticsRange {
  return {
    interval: query.interval,
    from: query.from,
    // Pure calendar arithmetic, so a UTC Date is only a day counter here.
    toExclusive: formatUtcDay(
      new Date(parseUtcDay(query.to).getTime() + DAY_MS),
    ),
    timeZone: ANALYTICS_TIMEZONE,
  };
}

/**
 * `from`/`to` stay strings rather than `z.coerce.date()`: a `Date` in a request
 * DTO cannot be represented in the OpenAPI document this app publishes at boot.
 * Both are calendar days in `ANALYTICS_TIMEZONE`. When absent, their defaults
 * depend on the requested chart granularity: hour=today, day=this month,
 * month=this year, year=the last five years.
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
