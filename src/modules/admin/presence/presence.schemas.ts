import { z } from 'zod';
import {
  CHANNEL_KINDS,
  type ChatChannelKind,
} from '../../../shared/channel/channel-kinds';

const channel = z.enum(
  Object.keys(CHANNEL_KINDS) as [ChatChannelKind, ...ChatChannelKind[]],
);

export const roomRefSchema = z.object({
  channel,
  conversationId: z.string().uuid(),
});

export const typingSchema = roomRefSchema.extend({
  typing: z.boolean(),
});

export type RoomRef = z.infer<typeof roomRefSchema>;
export type TypingPayload = z.infer<typeof typingSchema>;
