import type { StoredChannelKind } from '../../../shared/channel/channel-kinds';

/** One customer message, already authenticated and normalized by a connector. */
export type InboundMessage = Readonly<{
  /** Platform account that received it (Facebook page id). */
  accountId: string;
  /** Platform id of the sender (Facebook PSID). */
  externalUserId: string;
  /** Platform message id: the durable dedup key. */
  externalMessageId: string;
  /** Text the chatbot answers. Taps (postback) arrive here as text too. */
  text: string;
  /**
   * Content the chatbot cannot read yet (file, image, location). The gateway
   * answers with a fixed message and never calls the model.
   */
  unsupported?: boolean;
  /** Epoch ms from the platform. */
  sentAt: number;
}>;

export type OutboundTarget = Readonly<{
  accountId: string;
  externalUserId: string;
}>;

/** `retryable` failures are tried again; `permanent` ones are recorded and dropped. */
export type SendResult =
  | Readonly<{ ok: true; externalMessageId?: string }>
  | Readonly<{ ok: false; retryable: boolean; code: string }>;

export type WebhookRequest = Readonly<{
  /** Path segment after /webhooks (Facebook: channelKey); absent on the legacy URL. */
  routeKey?: string;
  rawBody?: Buffer | string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
}>;

/**
 * Everything a platform needs: verify the webhook, turn its payload into
 * InboundMessages, and send text back. Storage, ordering, idempotency,
 * retries, abuse limits, handoff and the chatbot itself live in the gateway.
 */
export interface ChannelConnector {
  readonly kind: StoredChannelKind;
  readonly limits: Readonly<{
    /** Longer replies are split into parts of at most this many characters. */
    maxTextLength: number;
    /** The platform refuses replies this long after the customer's last message. */
    replyWindowSec?: number;
  }>;
  /** False when the feature flag is off: webhooks answer 404. */
  readonly enabled: boolean;

  /** GET subscription handshake. Returns the challenge to echo, or null. */
  verifyChallenge?(
    query: Readonly<Record<string, unknown>>,
    routeKey?: string,
  ): string | null | Promise<string | null>;
  /** Signature over the exact raw body. */
  verifySignature(request: WebhookRequest): boolean | Promise<boolean>;
  /** Messages worth answering; delivery/read receipts and echoes are dropped. */
  parse(
    body: unknown,
    routeKey?: string,
  ): InboundMessage[] | Promise<InboundMessage[]>;
  /**
   * Company that owns the platform account, or null when the account is not
   * ours. Must never trust a company named by the payload.
   */
  resolveCompany(accountId: string): Promise<string | null>;
  send(target: OutboundTarget, text: string): Promise<SendResult>;
}
