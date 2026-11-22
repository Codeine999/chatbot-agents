import type { ChatChannelKind } from '../../../shared/channel/channel-kinds';

export type PresenceChannel = ChatChannelKind;

export interface PresenceViewer {
  adminId: string;
  name: string;
  typing: boolean;
}

export interface PresenceRoom {
  channel: PresenceChannel;
  conversationId: string;
  viewers: PresenceViewer[];
}

export type PresenceFailure =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'NOT_JOINED'
  | 'TOO_MANY_ROOMS'
  | 'UNAVAILABLE';

export type PresenceAck<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: PresenceFailure };
