import { Injectable, Logger } from '@nestjs/common';
import { LineChatSender } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RichMenuReplyCacheService } from '../../chatbot/menu/rich-menu-reply-cache.service';
import type { ChatResponse } from '../../../shared/contracts/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
} from '../../../shared/contracts/channel-adapter';
import type { LineWebhookEvent } from './dto/line';
import { LineService } from './delivery/line-reply.service';
import { LINE_EVENT_MAX_AGE_MS } from './worker/line-events.queue';
import { LineAdminService } from './admin/line-admin.service';
import { LineDeliveryService } from './delivery/line-delivery.service';
import { UserSessionService } from '../../session/user-session.service';
import { isUniqueConstraint, toChatMessage } from './line-message.mapper';
import { findOrCreateLineMember } from './line-member.repository';
import { LineImageArchiveService } from './media/line-image-archive.service';

type SavedIncomingEvent = {
  conversationId: string;
  lineMemberId: string;
  /** The conversation is `waiting_admin`; read with the row, no extra query. */
  handoffPending: boolean;
};

const WAITING_ADMIN = 'waiting_admin';

/** LINE transport and persistence boundary. Called only by the claimed queue worker. */
@Injectable()
export class LineChannelAdapter implements ChannelAdapter<
  LineWebhookEvent,
  SavedIncomingEvent
> {
  private readonly logger = new Logger(LineChannelAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineService: LineService,
    private readonly lineAdminService: LineAdminService,
    private readonly deliveryService: LineDeliveryService,
    private readonly richMenuReplies: RichMenuReplyCacheService,
    private readonly sessions: UserSessionService,
    private readonly images: LineImageArchiveService,
  ) {}

  async indicateProcessing(event: LineWebhookEvent): Promise<void> {
    // LINE shows the indicator only in one-on-one chats, and only turns that
    // toChatTurn() hands to the chatbot will be answered.
    if (event.source?.type !== 'user') return;
    if (
      event.type !== 'postback' &&
      !(
        event.type === 'message' &&
        ['text', 'image', 'sticker'].includes(event.message.type)
      )
    )
      return;

    try {
      // An admin-muted chat gets no automatic answer, so do not promise one.
      if (await this.sessions.isMuted(event.source.userId)) return;
      await this.lineService.startLoading(event.source.userId);
    } catch (error) {
      this.logger.warn(`LINE loading animation skipped: ${String(error)}`);
    }
  }

  async findDelivery(event: LineWebhookEvent) {
    return this.prisma.lineDelivery.findUnique({
      where: { key: event.webhookEventId },
    });
  }

  async markNoReply(
    event: LineWebhookEvent,
    thread: SavedIncomingEvent,
    claimOwner?: string,
  ): Promise<void> {
    // No turn downloads the photo while paused; fetch it for the inbox anyway.
    if (
      event.type === 'message' &&
      event.message.type === 'image' &&
      event.message.contentProvider?.type !== 'external'
    ) {
      this.images.fetchAndKeep(event.message.id);
    }
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
    await this.deliveryService.deliver(deliveryId);
  }

  toChatTurn(
    event: LineWebhookEvent,
    savedIncomingEvent: SavedIncomingEvent,
  ): Promise<ChatTurn | null> {
    return Promise.resolve(this.chatTurnOf(event, savedIncomingEvent));
  }

  /** Nothing here waits on I/O: an image's inbox copy is made in the background. */
  private chatTurnOf(
    event: LineWebhookEvent,
    savedIncomingEvent: SavedIncomingEvent,
  ): ChatTurn | null {
    if (event.type !== 'message' && event.type !== 'postback') return null;

    if (
      event.type === 'message' &&
      event.message.type !== 'text' &&
      event.message.type !== 'image' &&
      event.message.type !== 'sticker'
    ) {
      return null;
    }

    if (!event.source?.userId) return null;

    // Carried into every AI call so the resulting AiUsageEvent points back at
    // the thread that caused the spend.
    const thread = {
      lineMemberId: savedIncomingEvent.lineMemberId,
      conversationId: savedIncomingEvent.conversationId,
      // Ledger idempotency: re-processing the same webhook event settles the
      // same AI calls once instead of debiting the wallet a second time.
      turnId: event.webhookEventId,
    };

    let contextUserText: string;
    if (event.type === 'postback') {
      // LINE echoes a button's `displayText` into the customer's chat but does
      // not send it back, so the caption is read from the reply the button
      // points at. Stored context then reads as if the customer said it, and
      // an unrecognised button still carries its raw data into normal routing.
      contextUserText =
        this.richMenuReplies.byPostbackData(event.postback.data)?.label ??
        event.postback.data;

      return {
        kind: 'text',
        contextUserText,
        request: {
          userId: event.source.userId,
          ...thread,
          text: contextUserText,
          postbackData: event.postback.data,
        },
      };
    } else if (event.message.type === 'text') {
      contextUserText = event.message.text;
      return {
        kind: 'text',
        contextUserText,
        request: {
          userId: event.source.userId,
          ...thread,
          text: event.message.text,
        },
      };
    } else if (event.message.type === 'image') {
      contextUserText = '[image]';
      // The chatbot hands every photo to an admin without looking at it, so
      // the turn never waits for the download; the inbox copy is made in the
      // background. An external-provider image has no LINE content to copy.
      if (event.message.contentProvider?.type !== 'external') {
        this.images.fetchAndKeep(event.message.id);
      }
      return {
        kind: 'image',
        contextUserText,
        request: {
          userId: event.source.userId,
          ...thread,
        },
      };
    } else {
      contextUserText = event.message.text?.trim() || '[sticker]';
      return {
        kind: 'sticker',
        contextUserText,
        request: {
          userId: event.source.userId,
          ...thread,
          packageId: event.message.packageId,
          stickerId: event.message.stickerId,
          text: event.message.text,
          keywords: event.message.keywords,
        },
      };
    }
  }

  async saveReply(
    event: LineWebhookEvent,
    savedIncomingEvent: SavedIncomingEvent,
    turn: ChatTurn,
    response: ChatResponse,
    claimOwner?: string,
  ) {
    if (event.type !== 'message' && event.type !== 'postback') return null;
    const lineUserId = event.source.userId;
    if (!lineUserId) return null;
    return this.prisma.$transaction(async (tx) => {
      if (claimOwner) {
        const owned = await tx.processedLineWebhookEvent.updateMany({
          where: {
            webhookEventId: event.webhookEventId,
            leaseOwner: claimOwner,
            status: 'PROCESSING',
          },
          data: { leaseUntil: new Date(Date.now() + 120_000) },
        });
        if (!owned.count) throw new Error('Webhook lease lost');
      }
      if (!response.text.trim()) return null;
      return tx.lineDelivery.upsert({
        where: { key: event.webhookEventId },
        update: {},
        create: {
          key: event.webhookEventId,
          lineUserId,
          conversationId: savedIncomingEvent.conversationId,
          lineMemberId: savedIncomingEvent.lineMemberId,
          text: response.text,
          replyToken: event.replyToken,
          replyUntil: new Date(event.timestamp + LINE_EVENT_MAX_AGE_MS),
          context: {
            conversationId: savedIncomingEvent.conversationId,
            eventId: event.webhookEventId,
            userText: turn.contextUserText,
            response,
            createdAt: event.timestamp || Date.now(),
          },
        },
      });
    });
  }

  async saveIncomingEvent(
    event: LineWebhookEvent,
  ): Promise<SavedIncomingEvent | null> {
    const lineUserId = event.source?.userId;

    if (!lineUserId) return null;

    const chatMessage = toChatMessage(event);

    if (!chatMessage) return null;

    // A webhook retry can happen after the inbound transaction committed but
    // before LINE was replied to. Reuse the existing row so the conversation
    // unread count and USER history are not written twice.
    if (chatMessage.lineMessageId) {
      const existing = await this.prisma.lineChatHistory.findUnique({
        where: {
          lineMessageId: chatMessage.lineMessageId,
        },
        select: {
          conversationId: true,
          lineMemberId: true,
          conversation: { select: { status: true } },
        },
      });

      if (existing) return this.savedEvent(existing);
    }

    const member = await findOrCreateLineMember(
      this.prisma,
      this.lineAdminService,
      lineUserId,
    );
    const messageAt = new Date(event.timestamp || Date.now());

    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.lineConversation.upsert({
          where: {
            lineMemberId: member.id,
          },
          create: {
            lineMemberId: member.id,
            lastMessage: chatMessage.lastMessage,
            lastMessageType: chatMessage.messageType,
            lastMessageAt: messageAt,
            unreadCount: 1,
          },
          update: {
            lastMessage: chatMessage.lastMessage,
            lastMessageType: chatMessage.messageType,
            lastMessageAt: messageAt,
            unreadCount: {
              increment: 1,
            },
          },
        });

        await tx.lineChatHistory.create({
          data: {
            conversationId: conversation.id,
            lineMemberId: member.id,
            sender: LineChatSender.USER,
            messageType: chatMessage.messageType,
            text: chatMessage.text,
            lineMessageId: chatMessage.lineMessageId,
            replyToken: chatMessage.replyToken,
            stickerPackageId: chatMessage.stickerPackageId,
            stickerId: chatMessage.stickerId,
            stickerResourceType: chatMessage.stickerResourceType,
            mediaUrl: chatMessage.mediaUrl,
            postbackData: chatMessage.postbackData,
            rawEvent: event,
            sentStatus: 'received',
            createdAt: messageAt,
          },
        });

        await tx.lineMember.update({
          where: {
            id: member.id,
          },
          data: {
            lastActiveAt: messageAt,
          },
        });

        return {
          conversationId: conversation.id,
          lineMemberId: member.id,
          handoffPending: conversation.status === WAITING_ADMIN,
        };
      });
    } catch (error) {
      // Two workers can pass the read above concurrently. The unique index
      // is the final arbiter; return the committed row instead of retrying a
      // transaction that already rolled back its unread increment.
      if (
        chatMessage.lineMessageId &&
        isUniqueConstraint(error, 'lineMessageId')
      ) {
        const existing = await this.prisma.lineChatHistory.findUnique({
          where: {
            lineMessageId: chatMessage.lineMessageId,
          },
          select: {
            conversationId: true,
            lineMemberId: true,
            conversation: { select: { status: true } },
          },
        });

        if (existing) return this.savedEvent(existing);
      }

      throw error;
    }
  }

  /** A redelivered event reuses the stored row; its room status rides along. */
  private savedEvent(row: {
    conversationId: string;
    lineMemberId: string;
    conversation: { status: string };
  }): SavedIncomingEvent {
    return {
      conversationId: row.conversationId,
      lineMemberId: row.lineMemberId,
      handoffPending: row.conversation.status === WAITING_ADMIN,
    };
  }
}
