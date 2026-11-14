import { createHash } from 'node:crypto';
import type { StoredChannelKind } from '../../shared/channel/channel-kinds';
import type { InboundMessage } from './channel-connector';

/** Every connector's job of the shared chat-events queue (see events/queue). */
export const CHANNEL_EVENT_JOB = 'process-channel-event';
/** ~4 minutes of backoff: longer than a crashed turn's room lock. */
export const CHANNEL_EVENT_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1000 },
} as const;

export type ChannelEventJobData = Readonly<{
  kind: StoredChannelKind;
  message: InboundMessage;
}>;

/**
 * Same platform message → same job, so a webhook the platform redelivers
 * while the first is queued is dropped by BullMQ. The durable dedup is the
 * unique (conversationId, externalMessageId) on channelMessages. Hashed:
 * BullMQ job ids may not contain ':' and platform ids are long.
 */
export const channelEventJobId = (kind: string, externalMessageId: string) =>
  `${kind.toLowerCase()}-${createHash('sha256').update(externalMessageId).digest('hex').slice(0, 32)}`;
