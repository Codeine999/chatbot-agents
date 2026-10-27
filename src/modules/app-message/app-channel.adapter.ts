import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LoadContextService } from '../chatbot/context/load-context.service';
import type { ChatResponse } from '../chatbot/shared/types/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
  ConversationThread,
  DeliveryReference,
} from '../events/message/contracts/channel-adapter';
import { UserSessionService } from '../users/session/user-session.service';
import { APP_LIMITS } from './app-message.config';
import { buildReplyMetadata } from './app-message.metadata';
import { appUserId } from './app-session.service';

/** Built by AppMessageService after the inbound row is stored; never from a request body. */
export type AppInboundEvent = Readonly<{
  messageId: string;
  conversationId: string;
  contactId: string;
  companyId: string;
  text: string;
}>;

type StoredTurnContext = { userText: string; response: ChatResponse };

/**
 * App Message persistence boundary for MessageProcessorService.
 *
 * The inbound row and its unread increment are written by AppMessageService
 * before the turn starts (once per clientMessageId). The claim on the turn is
 * the room lock: `claimOwner` is the inbound message id held in
 * `channelConversations.activeTurnId`, so a turn whose lock expired and was
 * taken over cannot store a second answer.
 */
@Injectable()
export class AppChannelAdapter implements ChannelAdapter<
  AppInboundEvent,
  ConversationThread
> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: LoadContextService,
    private readonly sessions: UserSessionService,
  ) {}

  findDelivery(event: AppInboundEvent): Promise<DeliveryReference | null> {
    return this.prisma.channelMessage.findUnique({
      where: { replyToId: event.messageId },
      select: { id: true },
    });
  }

  saveIncomingEvent(event: AppInboundEvent): Promise<ConversationThread> {
    return Promise.resolve({ conversationId: event.conversationId });
  }

  toChatTurn(
    event: AppInboundEvent,
    thread: ConversationThread,
  ): Promise<ChatTurn> {
    return Promise.resolve({
      kind: 'text',
      contextUserText: event.text,
      // Only these fields reach the core: client metadata and display name
      // stay out of every prompt. No lineMemberId, so product RAG is skipped.
      request: {
        userId: appUserId(event.contactId),
        conversationId: thread.conversationId,
        turnId: `app:${event.messageId}`,
        text: event.text,
        channel: 'APP',
      },
    });
  }

  async saveReply(
    event: AppInboundEvent,
    thread: ConversationThread,
    turn: ChatTurn,
    response: ChatResponse,
    claimOwner?: string,
  ): Promise<DeliveryReference | null> {
    // Redis is not part of the transaction, so read the mute flag first. An
    // admin who answered while the model was thinking wins over the bot.
    const muted = await this.sessions.isMuted(appUserId(event.contactId));
    const silent = muted || !response.text.trim();

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.channelConversation.updateMany({
        where: {
          id: thread.conversationId,
          activeTurnId: claimOwner ?? event.messageId,
        },
        data: {
          activeUntil: new Date(Date.now() + APP_LIMITS.turnLockSec * 1000),
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
          status: 'SENT',
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

  /** Nothing is sent anywhere: the answer goes back in the HTTP response. */
  async deliver(deliveryId: string): Promise<void> {
    const reply = await this.prisma.channelMessage.findUnique({
      where: { id: deliveryId },
      select: {
        conversationId: true,
        replyToId: true,
        turnContext: true,
        createdAt: true,
      },
    });
    const stored = reply?.turnContext as StoredTurnContext | null | undefined;
    if (!reply?.replyToId || !stored) return;
    // Idempotent per eventId and never throws, so a replay is harmless.
    await this.context.appendTurn({
      conversationId: reply.conversationId,
      eventId: `app:${reply.replyToId}`,
      userText: stored.userText,
      response: stored.response,
      createdAt: reply.createdAt.getTime(),
    });
  }
}
