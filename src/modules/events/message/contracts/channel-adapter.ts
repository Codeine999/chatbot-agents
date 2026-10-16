import type {
  ChatRequest,
  ChatResponse,
  ImageChatRequest,
  StickerChatRequest,
} from '../../../chatbot/shared/types/chat.types';

/** Worker-local input, after channel authentication and inbound persistence.
 * Never accept this contract directly from an HTTP request. Identity and
 * usage attribution must be resolved by the trusted channel adapter.
 */
export type ChatTurn = Readonly<{ contextUserText: string }> &
  (
    | { kind: 'text'; request: Omit<ChatRequest, 'recentMessages'> }
    | { kind: 'image'; request: Omit<ImageChatRequest, 'recentMessages'> }
    | { kind: 'sticker'; request: Omit<StickerChatRequest, 'recentMessages'> }
    | { kind: 'response'; response: ChatResponse }
  );

export type ConversationThread = Readonly<{ conversationId: string }>;
export type DeliveryReference = Readonly<{ id: string }>;

/**
 * Channels own external payloads, identity/storage and delivery semantics.
 * Queue workers retain responsibility for authentication provenance, claims,
 * ordering and retries. Implementations must preserve durable idempotency.
 *
 * This port is an internal extraction boundary, not multi-tenant enablement:
 * the current chatbot session/handoff and billing still use legacy LINE IDs.
 */
export interface ChannelAdapter<TEvent, TThread extends ConversationThread> {
  findDelivery(event: TEvent): Promise<DeliveryReference | null>;
  saveIncomingEvent(event: TEvent): Promise<TThread | null>;
  /** Best-effort "working on it" signal. Never awaited by the worker. */
  indicateProcessing?(event: TEvent): Promise<void>;
  toChatTurn(event: TEvent, thread: TThread): Promise<ChatTurn | null>;
  saveReply(
    event: TEvent,
    thread: TThread,
    turn: ChatTurn,
    response: ChatResponse,
    claimOwner?: string,
  ): Promise<DeliveryReference | null>;
  /** Resume persisted delivery; do not reconstruct or blindly resend it. */
  deliver(deliveryId: string): Promise<void>;
}
