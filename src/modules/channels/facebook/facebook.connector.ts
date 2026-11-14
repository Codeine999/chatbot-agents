import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  ChannelConnector,
  InboundMessage,
  OutboundTarget,
  SendResult,
  WebhookRequest,
} from '../core/channel-connector';
import { ChannelConnectorRegistry } from '../core/channel-connector.registry';
import { FacebookConfig } from './facebook.config';
import {
  FacebookCredentialService,
  type FacebookCredentials,
} from './facebook-credential.service';
import {
  facebookWebhookSchema,
  graphErrorSchema,
  graphSendResultSchema,
  parseMessaging,
} from './facebook.schema';

/** Graph error codes that mean "slow down / try later". */
const THROTTLED = new Set([4, 17, 32, 613]);
/** code 10 + this subcode: sent outside the 24-hour standard messaging window. */
const OUTSIDE_WINDOW_SUBCODE = 2018278;

/**
 * Facebook Messenger. Each Page has its own app secret and token, found per
 * request: by the channelKey in the webhook URL, or by page id for replies.
 * Webhook: X-Hub-Signature-256 over the raw body with the app secret. Replies:
 * Send API, `messaging_type: RESPONSE`, which Messenger accepts within 24 hours
 * of the customer's last message.
 */
@Injectable()
export class FacebookConnector implements ChannelConnector, OnModuleInit {
  readonly kind = 'FACEBOOK' as const;
  readonly limits = { maxTextLength: 2000, replyWindowSec: 24 * 3600 };
  /** Pages come from the database, so the webhook is always routable. */
  readonly enabled = true;
  private readonly logger = new Logger(FacebookConnector.name);

  constructor(
    private readonly config: FacebookConfig,
    private readonly registry: ChannelConnectorRegistry,
    private readonly credentials: FacebookCredentialService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  private forRoute(routeKey?: string): Promise<FacebookCredentials | null> {
    return routeKey
      ? this.credentials.forChannelKey(routeKey)
      : this.credentials.forLegacyUrl();
  }

  async verifyChallenge(
    query: Readonly<Record<string, unknown>>,
    routeKey?: string,
  ): Promise<string | null> {
    const credentials = await this.forRoute(routeKey);
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      !credentials ||
      query['hub.mode'] !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      !safeEqual(token, credentials.verifyToken)
    )
      return null;
    return challenge;
  }

  async verifySignature({
    rawBody,
    headers,
    routeKey,
  }: WebhookRequest): Promise<boolean> {
    const header = headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !rawBody) return false;
    const [scheme, hex] = header.split('=', 2);
    if (scheme !== 'sha256' || !hex || !/^[0-9a-f]{64}$/i.test(hex))
      return false;
    const credentials = await this.forRoute(routeKey);
    if (!credentials) return false;
    const expected = createHmac('sha256', credentials.appSecret)
      .update(rawBody)
      .digest();
    return timingSafeEqual(Buffer.from(hex, 'hex'), expected);
  }

  async parse(body: unknown, routeKey?: string): Promise<InboundMessage[]> {
    const webhook = facebookWebhookSchema.safeParse(body);
    const credentials = await this.forRoute(routeKey);
    if (!credentials || !webhook.success) return [];

    const messages: InboundMessage[] = [];
    for (const entry of webhook.data.entry) {
      // A signed body for another Page of the same app must not land here.
      if (entry.id !== credentials.pageId) continue;
      for (const raw of entry.messaging ?? []) {
        const parsed = parseMessaging(raw);
        if (!parsed.success) continue;
        const message = toInbound(parsed.data);
        if (message) messages.push(message);
      }
    }
    return messages;
  }

  async resolveCompany(accountId: string): Promise<string | null> {
    return (await this.credentials.forPageId(accountId))?.companyId ?? null;
  }

  async send(target: OutboundTarget, text: string): Promise<SendResult> {
    const credentials = await this.credentials.forPageId(target.accountId);
    if (!credentials)
      return { ok: false, retryable: false, code: 'FB_NOT_CONFIGURED' };
    const settings = {
      ...this.config.transport,
      pageAccessToken: credentials.pageAccessToken,
    };

    let response: Response;
    try {
      response = await fetch(`${settings.graphBaseUrl}/me/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.pageAccessToken}`,
        },
        body: JSON.stringify({
          recipient: { id: target.externalUserId },
          messaging_type: 'RESPONSE',
          message: { text },
        }),
        signal: AbortSignal.timeout(settings.sendTimeoutMs),
      });
    } catch (error) {
      this.logger.warn(
        `send failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return { ok: false, retryable: true, code: 'FB_NETWORK' };
    }

    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const result = graphSendResultSchema.safeParse(body);
      return {
        ok: true,
        externalMessageId: result.success ? result.data.message_id : undefined,
      };
    }
    return sendFailure(response.status, body);
  }
}

function toInbound(
  event: NonNullable<ReturnType<typeof parseMessaging>['data']>,
): InboundMessage | null {
  const base = {
    accountId: event.recipient.id,
    externalUserId: event.sender.id,
    sentAt: event.timestamp,
  };
  const { message, postback } = event;
  if (message) {
    if (message.is_echo) return null; // our own reply coming back
    const text = message.text?.trim();
    if (text) return { ...base, externalMessageId: message.mid, text };
    if (message.attachments?.length)
      return {
        ...base,
        externalMessageId: message.mid,
        text: '',
        unsupported: true,
      };
    return null;
  }
  // A button tap reads as what the customer pressed.
  const title = postback?.title?.trim();
  if (postback && title)
    return {
      ...base,
      externalMessageId:
        postback.mid ?? `postback:${event.sender.id}:${event.timestamp}`,
      text: title,
    };
  return null;
}

function sendFailure(status: number, body: unknown): SendResult {
  const parsed = graphErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  const subcode = parsed.success ? parsed.data.error.error_subcode : undefined;
  if (code === 10 && subcode === OUTSIDE_WINDOW_SUBCODE)
    return { ok: false, retryable: false, code: 'OUTSIDE_REPLY_WINDOW' };
  const retryable =
    status === 429 ||
    status >= 500 ||
    (code !== undefined && THROTTLED.has(code));
  return {
    ok: false,
    retryable,
    code: `FB_HTTP_${status}${code === undefined ? '' : `_${code}`}`,
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
