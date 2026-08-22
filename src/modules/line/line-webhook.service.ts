import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  LineChatMessageType,
  LineChatSender,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatbotService } from '../chatbot/chatbot.service';
import { LoadContextService } from '../chatbot/context/load-context.service';
import type { ChatResponse } from '../chatbot/types/chat.types';
import type {
  LineMessageEvent,
  LinePostbackEvent,
  LineWebhookEvent,
} from './dto/line';
import type {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import { LineService } from './line-reply.service';
import { LINE_EVENT_MAX_AGE_MS } from './line-events.queue';
import { LineAdminService } from './admin/line-admin.service';

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

@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineService: LineService,
    private readonly chatbotService: ChatbotService,
    private readonly loadContextService: LoadContextService,
    private readonly lineAdminService: LineAdminService,
  ) {}

  /**
   * Full handling of a single webhook event: persist it, run the chatbot,
   * reply to LINE, and save the outgoing chat history. Any error thrown
   * from here means no reply has been sent yet, so the caller may release
   * the idempotency claim and retry.
   */
  async processEvent(event: LineWebhookEvent): Promise<void> {
    const savedIncomingEvent = await this.saveIncomingEvent(event);

    if (event.type !== 'message') return;

    if (
      event.message.type !== 'text' &&
      event.message.type !== 'image' &&
      event.message.type !== 'sticker'
    ) {
      return;
    }

    if (!event.source?.userId) return;

    const recentMessages = savedIncomingEvent
      ? await this.loadContextService.load(savedIncomingEvent.conversationId)
      : [];

    let response: ChatResponse;
    let contextUserText: string;

    // Carried into every AI call so the resulting AiUsageEvent points back at
    // the thread that caused the spend.
    const thread = {
      lineMemberId: savedIncomingEvent?.lineMemberId,
      conversationId: savedIncomingEvent?.conversationId,
    };

    if (event.message.type === 'text') {
      contextUserText = event.message.text;
      response = await this.chatbotService.handleTextMessage({
        userId: event.source.userId,
        ...thread,
        text: event.message.text,
        recentMessages,
      });
    } else if (event.message.type === 'image') {
      contextUserText = '[image]';
      if (event.message.contentProvider?.type === 'external') {
        response = {
          text: 'ขออภัย ระบบยังไม่รองรับรูปภาพจากผู้ให้บริการภายนอก',
          source: 'SYSTEM',
          contextPolicy: 'EXCLUDE',
        };
      } else {
        const image = await this.lineService.getImageContent(event.message.id);
        response = await this.chatbotService.handleImageMessage({
          userId: event.source.userId,
          ...thread,
          image,
          recentMessages,
        });
      }
    } else {
      contextUserText = event.message.text?.trim() || '[sticker]';
      response = await this.chatbotService.handleStickerMessage({
        userId: event.source.userId,
        ...thread,
        packageId: event.message.packageId,
        stickerId: event.message.stickerId,
        text: event.message.text,
        keywords: event.message.keywords,
        recentMessages,
      });
    }

    if (Date.now() - event.timestamp > LINE_EVENT_MAX_AGE_MS) {
      this.logger.warn(
        `Skipping stale LINE reply for webhookEventId=${event.webhookEventId}`,
      );
      return;
    }

    const replySent = await this.lineService.replyText(
      event.replyToken,
      response.text,
    );

    if (!replySent) return;

    if (savedIncomingEvent) {
      try {
        await this.saveSystemReplyMessage(
          savedIncomingEvent.conversationId,
          savedIncomingEvent.lineMemberId,
          response.text,
        );
      } catch (error) {
        // The reply is already sent; retrying the job now would reply twice.
        this.logger.error(
          `Failed to save outgoing chat history for conversation ${savedIncomingEvent.conversationId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      if (response.contextPolicy === 'INCLUDE') {
        await this.loadContextService.appendTurn({
          conversationId: savedIncomingEvent.conversationId,
          eventId: event.webhookEventId,
          userText: contextUserText,
          response,
          createdAt: event.timestamp || Date.now(),
        });
      } else if (response.contextPolicy === 'CLEAR') {
        await this.loadContextService.clear(savedIncomingEvent.conversationId);
      }
    }
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

  listConversations() {
    return this.prisma.lineConversation.findMany({
      orderBy: [
        {
          lastMessageAt: 'desc',
        },
        {
          updatedAt: 'desc',
        },
      ],
      include: {
        lineMember: true,
      },
    });
  }

  async getConversationMessages(
    conversationId: string,
    query: GetLineMessagesQueryDto,
  ) {
    if (query.before && query.after) {
      throw new BadRequestException('Use either before or after, not both');
    }

    const before = this.parseBeforeDate(query.before);
    const after = this.parseAfterDate(query.after);
    const limit = query.limit ?? (after ? 100 : 30);

    const conversation = await this.prisma.lineConversation.findUnique({
      where: {
        id: conversationId,
      },
      select: {
        id: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('LINE conversation not found');
    }

    if (after) {
      return this.prisma.lineChatHistory.findMany({
        where: {
          conversationId,
          createdAt: {
            gt: after,
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
        take: limit,
      });
    }

    const messages = await this.prisma.lineChatHistory.findMany({
      where: {
        conversationId,
        createdAt: before
          ? {
              lt: before,
            }
          : undefined,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });

    return messages.reverse();
  }

  /**
   * Pushes an admin reply to the customer. `sentByAdminId` attributes the
   * message to the admin who sent it, so the back office can report who
   * answered how many customers by counting these rows.
   */
  async sendAdminMessage(
    conversationId: string,
    body: SendLineMessageDto,
    sentByAdminId?: string,
  ) {
    const conversation = await this.prisma.lineConversation.findUnique({
      where: {
        id: conversationId,
      },
      include: {
        lineMember: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('LINE conversation not found');
    }

    await this.lineAdminService.pushText(
      conversation.lineMember.lineUserId,
      body.text,
    );

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.lineChatHistory.create({
        data: {
          conversationId: conversation.id,
          lineMemberId: conversation.lineMemberId,
          sender: LineChatSender.ADMIN,
          messageType: LineChatMessageType.TEXT,
          text: body.text,
          sentStatus: 'sent',
          sentByAdminId: sentByAdminId ?? null,
          createdAt: now,
        },
      });

      await tx.lineConversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessage: body.text,
          lastMessageType: LineChatMessageType.TEXT,
          lastMessageAt: now,
        },
      });

      return message;
    });
  }

  async saveSystemReplyMessage(
    conversationId: string,
    lineMemberId: string,
    text: string,
  ) {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.lineChatHistory.create({
        data: {
          conversationId,
          lineMemberId,
          sender: LineChatSender.SYSTEM,
          messageType: LineChatMessageType.TEXT,
          text,
          sentStatus: 'sent',
          createdAt: now,
          rawEvent: {
            source: 'line_webhook_auto_reply',
          },
        },
      });

      await tx.lineConversation.update({
        where: {
          id: conversationId,
        },
        data: {
          lastMessage: text,
          lastMessageType: LineChatMessageType.TEXT,
          lastMessageAt: now,
        },
      });

      return message;
    });
  }

  /**
   * Claims a webhook event for processing by inserting its id under a
   * unique constraint. Returns false when the event was already claimed,
   * so a duplicate delivery is skipped and never replied to twice.
   */
  async claimWebhookEvent(webhookEventId: string): Promise<boolean> {
    try {
      await this.prisma.processedLineWebhookEvent.create({
        data: {
          webhookEventId,
        },
      });

      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }

      throw error;
    }
  }

  async releaseWebhookEvent(webhookEventId: string): Promise<void> {
    await this.prisma.processedLineWebhookEvent.deleteMany({
      where: {
        webhookEventId,
      },
    });
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

  private parseBeforeDate(before?: string): Date | undefined {
    if (!before) {
      return undefined;
    }

    const date = new Date(before);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid before date');
    }

    return date;
  }

  private parseAfterDate(after?: string): Date | undefined {
    if (!after) {
      return undefined;
    }

    const date = new Date(after);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid after date');
    }

    return date;
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
