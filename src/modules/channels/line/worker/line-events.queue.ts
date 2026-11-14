import type { LineWebhookEvent } from '../dto/line';

/** LINE jobs of the shared chat-events queue (see events/queue). */
export const LINE_EVENT_JOB = 'process-line-event';
/** A transient AI failure or a recovered webhook claim, tried again with backoff. */
export const LINE_EVENT_RETRY_JOB = 'retry-line-event';

/** A first delivery never retries in place: a failure worth retrying is re-added as a retry job. */
export const LINE_EVENT_JOB_OPTIONS = { attempts: 1 } as const;
export const LINE_EVENT_RETRY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
} as const;

export const LINE_EVENT_MAX_AGE_MS = 50_000;

export type LineEventJobData = {
  event: LineWebhookEvent;
};
