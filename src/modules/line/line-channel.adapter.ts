import { Injectable } from '@nestjs/common';
import {
  LineChatMessageType,
  LineChatSender,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RichMenuReplyCacheService } from '../chatbot/menu/rich-menu-reply-cache.service';
import type { ChatResponse } from '../chatbot/types/chat.types';
import type {
  ChannelAdapter,
  ChatTurn,
} from '../events/message/contracts/channel-adapter';
import type {
  LineMessageEvent,
  LinePostbackEvent,
  LineWebhookEvent,
} from './dto/line';
import { LineService } from './line-reply.service';
import { LINE_EVENT_MAX_AGE_MS } from './line-events.queue';
import { LineAdminService } from './admin/line-admin.service';
import { LineDeliveryService } from './line-delivery.service';

type IncomingLineChatMessage = {
  messageType: LineChatMessageType;
  lastMessage: string;
  text?: string;
  lineMessageId?: string;
  replyToken?: string;
  stickerPackageId?: string;
  stickerId?: string;
  stickerResourceType?: string;
  mediaUrl?: string | null;
  postbackData?: string;
};

type SavedIncomingEvent = {
  conversationId: string;
  lineMemberId: string;
};

/** LINE transport and persistence boundary. Called only by the claimed queue worker. */
@Injectable()
export class LineChannelAdapter implements ChannelAdapter<
  LineWebhookEvent,
  SavedIncomingEvent
> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lineService: LineService,
    private readonly lineAdminService: LineAdminService,
    private readonly deliveryService: LineDeliveryService,
    private readonly richMenuReplies: RichMenuReplyCacheService,
  ) {}

  async findDelivery(event: LineWebhookEvent) {
    return this.prisma.lineDelivery.findUnique({
      where: { key: event.webhookEventId },
    });
  }

  async deliver(deliveryId: string): Promise<void> {
    await this.deliveryService.deliver(deliveryId);
  }

  async toChatTurn(
    event: LineWebhookEvent,
    savedIncomingEvent: SavedIncomingEvent,
  ): Promise<ChatTurn | null> {
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
      if (event.message.contentProvider?.type === 'external') {
        return {
          kind: 'response',
          contextUserText,
          response: {
            text: 'ขออภัย ระบบยังไม่รองรับรูปภาพจากผู้ให้บริการภายนอก',
            source: 'SYSTEM',
            contextPolicy: 'EXCLUDE',
          },
        };
      } else {
        const image = await this.lineService.getImageContent(event.message.id);
        return {
          kind: 'image',
          contextUserText,
          request: {
            userId: event.source.userId,
            ...thread,
            image,
          },
        };
      }
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

    const chatMessage = this.toChatMessage(event);

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
        },
      });

      if (existing) return existing;
    }

    const member = await this.findOrCreateLineMember(lineUserId);
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
        };
      });
    } catch (error) {
      // Two workers can pass the read above concurrently. The unique index
      // is the final arbiter; return the committed row instead of retrying a
      // transaction that already rolled back its unread increment.
      if (
        chatMessage.lineMessageId &&
        this.isUniqueConstraint(error, 'lineMessageId')
      ) {
        const existing = await this.prisma.lineChatHistory.findUnique({
          where: {
            lineMessageId: chatMessage.lineMessageId,
          },
          select: {
            conversationId: true,
            lineMemberId: true,
          },
        });

        if (existing) return existing;
      }

      throw error;
    }
  }

  private async findOrCreateLineMember(lineUserId: string) {
    const existingMember = await this.prisma.lineMember.findUnique({
      where: {
        lineUserId,
      },
    });

    if (existingMember) {
      return existingMember;
    }

    const profile = await this.lineAdminService.getProfile(lineUserId);
    const syncedAt = new Date();

    return this.prisma.lineMember.upsert({
      where: {
        lineUserId,
      },
      create: {
        lineUserId,
        displayName: profile.displayName || lineUserId,
        pictureUrl: profile.pictureUrl,
        statusMessage: profile.statusMessage,
        profileSyncedAt: syncedAt,
      },
      update: {
        displayName: profile.displayName || lineUserId,
        pictureUrl: profile.pictureUrl,
        statusMessage: profile.statusMessage,
        profileSyncedAt: syncedAt,
      },
    });
  }

  private toChatMessage(
    event: LineWebhookEvent,
  ): IncomingLineChatMessage | null {
    if (event.type === 'message') {
      return this.toMessageEventChatMessage(event);
    }

    if (event.type === 'postback') {
      return this.toPostbackEventChatMessage(event);
    }

    return null;
  }

  private toMessageEventChatMessage(
    event: LineMessageEvent,
  ): IncomingLineChatMessage | null {
    const { message } = event;

    if (message.type === 'text') {
      return {
        messageType: LineChatMessageType.TEXT,
        lastMessage: message.text,
        text: message.text,
        lineMessageId: message.id,
        replyToken: event.replyToken,
      };
    }

    if (message.type === 'image') {
      return {
        messageType: LineChatMessageType.IMAGE,
        lastMessage: '[image]',
        lineMessageId: message.id,
        replyToken: event.replyToken,
        mediaUrl: null,
      };
    }

    if (message.type === 'sticker') {
      const stickerText = message.text?.trim();

      return {
        messageType: LineChatMessageType.STICKER,
        lastMessage: stickerText || '[sticker]',
        text: stickerText || undefined,
        lineMessageId: message.id,
        replyToken: event.replyToken,
        stickerPackageId: message.packageId,
        stickerId: message.stickerId,
        stickerResourceType: message.stickerResourceType,
      };
    }

    return null;
  }

  private toPostbackEventChatMessage(
    event: LinePostbackEvent,
  ): IncomingLineChatMessage {
    return {
      messageType: LineChatMessageType.POSTBACK,
      lastMessage: event.postback.data,
      replyToken: event.replyToken,
      postbackData: event.postback.data,
    };
  }

  private isUniqueConstraint(error: unknown, field: string): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    if (error.code !== 'P2002') return false;

    const target = error.meta?.target;
    return Array.isArray(target) ? target.includes(field) : target === field;
  }
}
