import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CHANNEL_KINDS,
  channelUserId,
  type StoredChannelKind,
} from '../../../shared/channel/channel-kinds';
import { LoadContextService } from '../../chatbot/context/load-context.service';
import type { ChatResponse } from '../../../shared/contracts/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
  ConversationThread,
  DeliveryReference,
} from '../../../shared/contracts/channel-adapter';
import { UserSessionService } from '../../session/user-session.service';
import { ChannelConnectorRegistry } from './channel-connector.registry';
import { buildReplyMetadata } from './channel-message.metadata';
import { ChannelOutboundService } from './channel-outbound.service';

/** How long one turn may hold its room before another worker/request can take over. */
export const CHANNEL_TURN_LOCK_SEC = 120;

export type ChannelInboundEvent = Readonly<{
  channel: StoredChannelKind;
  messageId: string;
  conversationId: string;
  contactId: string;
  companyId: string;
  text: string;
  response?: ChatResponse;
}>;

type StoredTurnContext = { userText: string; response: ChatResponse };

@Injectable()
export class ChannelStoreAdapter implements ChannelAdapter<
  ChannelInboundEvent,
  ConversationThread
> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: LoadContextService,
    private readonly sessions: UserSessionService,
    private readonly connectors: ChannelConnectorRegistry,
    private readonly outbound: ChannelOutboundService,
  ) {}

  findDelivery(event: ChannelInboundEvent): Promise<DeliveryReference | null> {
    return this.prisma.channelMessage.findUnique({
      where: { replyToId: event.messageId },
      select: { id: true },
    });
  }

  saveIncomingEvent(event: ChannelInboundEvent): Promise<ConversationThread> {
    return Promise.resolve({ conversationId: event.conversationId });
  }

  toChatTurn(
    event: ChannelInboundEvent,
    thread: ConversationThread,
  ): Promise<ChatTurn> {
    if (event.response)
      return Promise.resolve({
        kind: 'response',
        contextUserText: event.text,
        response: event.response,
      });
    return Promise.resolve({
      kind: 'text',
      contextUserText: event.text,
      // Only these fields reach the core: platform metadata and display names
      // stay out of every prompt. Product RAG finds the channel from the
      // prefixed userId and the room from conversationId (no LINE member).
      request: {
        userId: channelUserId(event.channel, event.contactId),
        conversationId: thread.conversationId,
        turnId: this.turnId(event.channel, event.messageId),
        text: event.text,
        channel: event.channel,
      },
    });
  }

  async saveReply(
    event: ChannelInboundEvent,
    thread: ConversationThread,
    turn: ChatTurn,
    response: ChatResponse,
    claimOwner?: string,
  ): Promise<DeliveryReference | null> {
    // Redis is not part of the transaction, so read the mute flag first. An
    // admin who answered while the model was thinking wins over the bot.
    const muted = await this.sessions.isMuted(
      channelUserId(event.channel, event.contactId),
    );
    const silent = muted || !response.text.trim();
    const pushed = Boolean(this.connectors.find(event.channel));

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.channelConversation.updateMany({
        where: {
          id: thread.conversationId,
          activeTurnId: claimOwner ?? event.messageId,
        },
        data: {
          activeUntil: new Date(Date.now() + CHANNEL_TURN_LOCK_SEC * 1000),
        },
      });
      if (!claimed.count) throw new Error('Turn lock lost');

      if (silent) {
        await tx.channelMessage.update({
          where: { id: event.messageId },
          data: { status: 'NO_REPLY' },
        });
        return null;
      }

      const [inbound, conversation] = await Promise.all([
        tx.channelMessage.findUniqueOrThrow({
          where: { id: event.messageId },
          select: { createdAt: true },
        }),
        tx.channelConversation.findUniqueOrThrow({
          where: { id: thread.conversationId },
          select: { status: true },
        }),
      ]);
      // A reply must sort after its question even in the same millisecond.
      const createdAt = new Date(
        Math.max(Date.now(), inbound.createdAt.getTime() + 1),
      );
      const turnContext: StoredTurnContext = {
        userText: turn.contextUserText,
        response,
      };
      const reply = await tx.channelMessage.create({
        data: {
          companyId: event.companyId,
          conversationId: thread.conversationId,
          contactId: event.contactId,
          sender:
            response.source === 'AI' || response.source === 'KNOWLEDGE'
              ? 'AI'
              : 'SYSTEM',
          text: response.text,
          // Pushed after commit, never inside this transaction.
          status: pushed ? 'PENDING' : 'SENT',
          source: response.source,
          replyToId: event.messageId,
          turnContext,
          metadata: buildReplyMetadata(
            response,
            conversation.status === 'waiting_admin',
          ),
          createdAt,
        },
        select: { id: true },
      });
      await tx.channelConversation.update({
        where: { id: thread.conversationId },
        data: {
          lastMessage: response.text.slice(0, 200),
          lastMessageAt: createdAt,
        },
      });
      await tx.channelMessage.update({
        where: { id: event.messageId },
        data: { status: 'ANSWERED' },
      });
      return reply;
    });
  }

  /**
   * The App channel is the back-office test chat, so it keeps answering while
   * the global pause silences customer-facing channels (LINE, Facebook).
   */
  bypassesPipelinePause(event: ChannelInboundEvent): boolean {
    return event.channel === 'APP';
  }

  /**
   * Push channels: send (or resume sending) the stored reply; a retryable
   * failure throws so the queue tries again. Chat context is appended only
   * once the platform accepted the reply. App: nothing to send.
   */
  async markNoReply(
    event: ChannelInboundEvent,
    thread: ConversationThread,
    claimOwner?: string,
  ): Promise<void> {
    // An empty reply is already the "stay silent" path of saveReply: it keeps
    // the turn lock / lease honest and records NO_REPLY without delivering.
    const response: ChatResponse = {
      text: '',
      source: 'SYSTEM',
      contextPolicy: 'EXCLUDE',
    };
    await this.saveReply(
      event,
      thread,
      { kind: 'response', contextUserText: '', response },
      response,
      claimOwner,
    );
  }

  async deliver(deliveryId: string): Promise<void> {
    const reply = await this.prisma.channelMessage.findUnique({
      where: { id: deliveryId },
      select: {
        conversationId: true,
        replyToId: true,
        turnContext: true,
        createdAt: true,
        status: true,
        conversation: { select: { channel: true } },
      },
    });
    const stored = reply?.turnContext as StoredTurnContext | null | undefined;
    if (!reply?.replyToId || !stored) return;

    const channel = reply.conversation.channel;
    if (reply.status !== 'SENT' && this.connectors.find(channel)) {
      if ((await this.outbound.deliver(deliveryId)) !== 'SENT') return;
    }
    // Idempotent per eventId and never throws, so a replay is harmless.
    await this.context.appendTurn({
      conversationId: reply.conversationId,
      eventId: this.turnId(channel, reply.replyToId),
      userText: stored.userText,
      response: stored.response,
      createdAt: reply.createdAt.getTime(),
    });
  }

  /** Billing and the decision log key a turn by this; keep it stable per message. */
  private turnId(channel: StoredChannelKind, messageId: string) {
    return `${CHANNEL_KINDS[channel].userIdPrefix}${messageId}`;
  }
}
