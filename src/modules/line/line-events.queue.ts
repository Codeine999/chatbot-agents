import type { ConfigService } from '@nestjs/config';
import type { LineWebhookEvent } from './dto/line';

export const LINE_EVENTS_QUEUE = 'line-events';
export const LINE_EVENTS_RETRY_QUEUE = 'line-events-retry';

export const LINE_EVENTS_CONCURRENCY = 10;
export const LINE_EVENTS_RETRY_CONCURRENCY = 3;
/** Jobs started per `duration` ms across the whole queue, all instances included. */
export const LINE_EVENTS_RATE_LIMIT = { max: 12, duration: 1000 } as const;

const positiveInt = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
};

export function lineEventsWorkerSettings(config: ConfigService) {
  return {
    concurrency: positiveInt(
      config.get('LINE_EVENTS_CONCURRENCY'),
      LINE_EVENTS_CONCURRENCY,
    ),
    retryConcurrency: positiveInt(
      config.get('LINE_EVENTS_RETRY_CONCURRENCY'),
      LINE_EVENTS_RETRY_CONCURRENCY,
    ),
    rateLimit: {
      max: positiveInt(
        config.get('LINE_EVENTS_RATE_LIMIT_MAX'),
        LINE_EVENTS_RATE_LIMIT.max,
      ),
      duration: positiveInt(
        config.get('LINE_EVENTS_RATE_LIMIT_DURATION_MS'),
        LINE_EVENTS_RATE_LIMIT.duration,
      ),
    },
  };
}

export const LINE_EVENT_JOB = 'process-line-event';

export const LINE_EVENT_MAX_AGE_MS = 50_000;

export type LineEventJobData = {
  event: LineWebhookEvent;
};
