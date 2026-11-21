import {
  parseChannelUserId,
  type StoredChannelKind,
} from '../../../shared/channel/channel-kinds';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';

/**
 * Who a product turn belongs to. Product RAG works for every channel: a LINE
 * member in a LINE thread, or a contact in a channel* room (App, Facebook).
 * `userId` is the chatbot user id the adapter built for this conversation; the
 * database ownership check in CommerceTurnService is what makes it trusted.
 */
export type CommerceOwner =
  | Readonly<{
      kind: 'LINE';
      userId: string;
      lineMemberId: string;
      conversationId: string;
    }>
  | Readonly<{
      kind: 'CHANNEL';
      channel: StoredChannelKind;
      userId: string;
      contactId: string;
      /** The channelConversations row. */
      conversationId: string;
    }>
  /** Back-office "view as customer" session: no durable room, only a session. */
  | Readonly<{
      kind: 'PREVIEW';
      userId: string;
      adminMemberId: string;
      sessionId: string;
    }>;

const PREVIEW_USER_ID = /^preview:([0-9a-f-]{36}):([0-9a-f-]{36})$/i;
export const previewSessionKey = (owner: {
  adminMemberId: string;
  sessionId: string;
}) => `${owner.adminMemberId}:${owner.sessionId}`;

/** undefined = this turn has no durable conversation, so product RAG is skipped. */
export function commerceOwner(
  context: LineAiUsageContext,
): CommerceOwner | undefined {
  const { userId, conversationId, turnId, lineMemberId } = context;
  if (!userId || !turnId) return undefined;
  // `preview:` cannot collide with a LINE id (`U…`) or a channel prefix.
  const preview = PREVIEW_USER_ID.exec(userId);
  if (preview)
    return {
      kind: 'PREVIEW',
      userId,
      adminMemberId: preview[1],
      sessionId: preview[2],
    };
  if (!conversationId) return undefined;
  if (lineMemberId)
    return { kind: 'LINE', userId, lineMemberId, conversationId };
  const channel = parseChannelUserId(userId);
  return channel
    ? {
        kind: 'CHANNEL',
        channel: channel.channel,
        userId,
        contactId: channel.contactId,
        conversationId,
      }
    : undefined;
}

/** The commerceTurns owner columns of an owner (the other kind's stay null). */
export function ownerColumns(owner: CommerceOwner) {
  const none = {
    lineMemberId: null,
    conversationId: null,
    channelConversationId: null,
    previewSessionKey: null,
  };
  switch (owner.kind) {
    case 'LINE':
      return {
        ...none,
        lineMemberId: owner.lineMemberId,
        conversationId: owner.conversationId,
      };
    case 'CHANNEL':
      return { ...none, channelConversationId: owner.conversationId };
    case 'PREVIEW':
      return { ...none, previewSessionKey: previewSessionKey(owner) };
  }
}

type StoredOwner = {
  lineMemberId: string | null;
  conversationId: string | null;
  channelConversationId: string | null;
  previewSessionKey: string | null;
};
export const turnBelongsTo = (turn: StoredOwner, owner: CommerceOwner) => {
  const want = ownerColumns(owner);
  return (
    turn.lineMemberId === want.lineMemberId &&
    turn.conversationId === want.conversationId &&
    turn.channelConversationId === want.channelConversationId &&
    turn.previewSessionKey === want.previewSessionKey
  );
};
