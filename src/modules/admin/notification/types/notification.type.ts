import { z } from 'zod';
import type { AdminNotification as AdminNotificationRow } from '../../../../generated/prisma/client';

/**
 * Shape of `AdminNotification.metadata`.
 *
 * `conversationId` is the whole point of this payload: it is what the back
 * office puts in `/api/conversations/:conversationId/messages` when an admin
 * clicks the notification, so they land straight in that customer's chat.
 * `displayName`, `pictureUrl` and `lastMessage` are snapshotted here so the
 * notification list renders without joining LineConversation/LineMember.
 *
 * Every field is nullish because rows written before this shape existed still
 * have to parse — see `parseNotificationMetadata`.
 */
export const notificationMetadataSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  displayName: z.string().nullish(),
  pictureUrl: z.string().nullish(),
  lastMessage: z.string().nullish(),
  flow: z.string().nullish(),
  step: z.string().nullish(),
  status: z.string().nullish(),
});

export type NotificationMetadata = z.infer<typeof notificationMetadataSchema>;

/** A notification row with `metadata` narrowed from `JsonValue` to a real type. */
export type AdminNotification = Omit<AdminNotificationRow, 'metadata'> & {
  metadata: NotificationMetadata | null;
};

/** Returns null instead of throwing, so one legacy row cannot break the list. */
export function parseNotificationMetadata(
  value: unknown,
): NotificationMetadata | null {
  const parsed = notificationMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAdminNotification(
  row: AdminNotificationRow,
): AdminNotification {
  return { ...row, metadata: parseNotificationMetadata(row.metadata) };
}
