import type { LineWebhookEvent } from './dto/line';

export const LINE_EVENTS_QUEUE = 'line-events';

export const LINE_EVENT_JOB = 'process-line-event';

/**
 * LINE reply tokens expire quickly (about one minute after delivery).
 * Jobs older than this are dropped instead of replying with a dead token.
 */
export const LINE_EVENT_MAX_AGE_MS = 50_000;

export type LineEventJobData = {
  event: LineWebhookEvent;
};
