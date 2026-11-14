import type { ConfigService } from '@nestjs/config';

/**
 * The one inbound queue of every chat channel (LINE and every connector).
 * Jobs are told apart by name; ChatEventsProcessor hands each to its handler.
 * Retry policy is per job (see each channel's `*_JOB_OPTIONS`), not per queue.
 */
export const CHAT_EVENTS_QUEUE = 'chat-events';

export const CHAT_EVENTS_CONCURRENCY = 10;
/** Jobs started per `duration` ms across the whole queue, all instances included. */
export const CHAT_EVENTS_RATE_LIMIT = { max: 12, duration: 1000 } as const;

export const CHAT_EVENTS_RETENTION = {
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 24 * 3600 },
} as const;

const positiveInt = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
};

/** Env names predate the shared queue (it was LINE-only), kept so deployed settings still apply. */
export function chatEventsWorkerSettings(config: ConfigService) {
  return {
    concurrency: positiveInt(
      config.get('LINE_EVENTS_CONCURRENCY'),
      CHAT_EVENTS_CONCURRENCY,
    ),
    rateLimit: {
      max: positiveInt(
        config.get('LINE_EVENTS_RATE_LIMIT_MAX'),
        CHAT_EVENTS_RATE_LIMIT.max,
      ),
      duration: positiveInt(
        config.get('LINE_EVENTS_RATE_LIMIT_DURATION_MS'),
        CHAT_EVENTS_RATE_LIMIT.duration,
      ),
    },
  };
}
