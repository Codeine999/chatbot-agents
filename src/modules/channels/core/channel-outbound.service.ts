import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ChannelConnector, SendResult } from './channel-connector';
import { ChannelConnectorRegistry } from './channel-connector.registry';

/** A SENDING row whose worker died can be claimed again after this. */
const SEND_LEASE_SEC = 60;

export type DeliveryState = 'SENT' | 'FAILED' | 'BUSY';

/** Thrown for a failure worth retrying; the queue backs off and retries. */
export class ChannelDeliveryError extends Error {
  constructor(readonly code: string) {
    super(`channel delivery failed: ${code}`);
    this.name = 'ChannelDeliveryError';
  }
}

/** Platform-agnostic delivery fails a connector cannot report itself. */
const failure = (code: string, retryable = false): SendResult => ({
  ok: false,
  retryable,
  code,
});

/**
 * Sends a stored outbound channelMessage (bot or admin reply) through its
 * channel's connector, at most one attempt at a time per message:
 *
 *   PENDING ─claim→ SENDING ─accepted→ SENT
 *                      ├─retryable→ PENDING (ChannelDeliveryError thrown)
 *                      └─permanent→ FAILED
 *
 * Called after the row is committed, never inside a transaction. A crash
 * after the platform accepted but before SENT is stored resends once the
 * lease expires (at-least-once, like any webhook platform).
 */
@Injectable()
export class ChannelOutboundService {
  private readonly logger = new Logger(ChannelOutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ChannelConnectorRegistry,
  ) {}

  /** `retryFailed`: an admin pressing send again may retry a FAILED message. */
  async deliver(
    messageId: string,
    { retryFailed = false } = {},
  ): Promise<DeliveryState> {
    const now = new Date();
    const claimed = await this.prisma.channelMessage.updateMany({
      where: {
        id: messageId,
        OR: [
          { status: 'PENDING' },
          ...(retryFailed ? [{ status: 'FAILED' }] : []),
          { status: 'SENDING', deliveryLeaseUntil: { lt: now } },
        ],
      },
      data: {
        status: 'SENDING',
        deliveryLeaseUntil: new Date(now.getTime() + SEND_LEASE_SEC * 1000),
        deliveryAttempts: { increment: 1 },
      },
    });
    if (!claimed.count) {
      const row = await this.prisma.channelMessage.findUnique({
        where: { id: messageId },
        select: { status: true },
      });
      return row?.status === 'SENT' || row?.status === 'FAILED'
        ? row.status
        : 'BUSY';
    }

    const message = await this.prisma.channelMessage.findUniqueOrThrow({
      where: { id: messageId },
      select: {
        text: true,
        conversation: { select: { channel: true } },
        contact: {
          select: { externalUserId: true, metadata: true, lastActiveAt: true },
        },
      },
    });
    const connector = this.connectors.find(message.conversation.channel);
    const result = connector
      ? await this.send(connector, message)
      : failure('NO_CONNECTOR');
    return this.finish(messageId, result);
  }

  private async send(
    connector: ChannelConnector,
    message: {
      text: string | null;
      contact: {
        externalUserId: string | null;
        metadata: unknown;
        lastActiveAt: Date | null;
      };
    },
  ): Promise<SendResult> {
    const { externalUserId, metadata, lastActiveAt } = message.contact;
    const accountId = (metadata as { accountId?: unknown } | null)?.accountId;
    if (!externalUserId || typeof accountId !== 'string')
      return failure('NO_RECIPIENT');
    if (!message.text?.trim()) return failure('EMPTY');

    const window = connector.limits.replyWindowSec;
    if (
      window &&
      (!lastActiveAt || Date.now() - lastActiveAt.getTime() > window * 1000)
    )
      return failure('OUTSIDE_REPLY_WINDOW');

    let last: SendResult = failure('EMPTY');
    for (const part of splitText(
      message.text,
      connector.limits.maxTextLength,
    )) {
      try {
        last = await connector.send({ accountId, externalUserId }, part);
      } catch (error) {
        // Connectors should not throw; treat it as a network fault.
        this.logger.warn(
          `${connector.kind} send threw: ${error instanceof Error ? error.name : 'unknown'}`,
        );
        last = failure('SEND_ERROR', true);
      }
      if (!last.ok) break;
    }
    return last;
  }

  private async finish(
    messageId: string,
    result: SendResult,
  ): Promise<DeliveryState> {
    if (result.ok) {
      await this.prisma.channelMessage.update({
        where: { id: messageId },
        data: {
          status: 'SENT',
          externalMessageId: result.externalMessageId ?? null,
          deliveryLeaseUntil: null,
          lastError: null,
        },
      });
      return 'SENT';
    }
    await this.prisma.channelMessage.update({
      where: { id: messageId },
      data: {
        status: result.retryable ? 'PENDING' : 'FAILED',
        deliveryLeaseUntil: null,
        lastError: result.code.slice(0, 200),
      },
    });
    this.logger.warn(
      `channel delivery ${result.retryable ? 'retry' : 'failed'} message=${messageId} code=${result.code}`,
    );
    if (result.retryable) throw new ChannelDeliveryError(result.code);
    return 'FAILED';
  }
}

/** Splits on the last newline/space before the limit when there is one. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
