import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LineChatMessageType,
  LineChatSender,
  type Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly lineService: LineService,
  ) {}

  async saveIncomingEvent(
    event: LineWebhookEvent,
  ): Promise<SavedIncomingEvent | null> {
    const lineUserId = event.source?.userId;

    if (!lineUserId) {
      return null;
    }

    const chatMessage = this.toChatMessage(event);

    if (!chatMessage) {
      return null;
    }

    const member = await this.findOrCreateLineMember(lineUserId);
    const messageAt = new Date(event.timestamp || Date.now());

    return this.prisma.$transaction(async (tx) => {
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
          rawEvent: event as unknown as Prisma.InputJsonValue,
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

  async sendAdminMessage(conversationId: string, body: SendLineMessageDto) {
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

    await this.lineService.pushText(
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

  private async findOrCreateLineMember(lineUserId: string) {
    const existingMember = await this.prisma.lineMember.findUnique({
      where: {
        lineUserId,
      },
    });

    if (existingMember) {
      return existingMember;
    }

    const profile = await this.lineService.getProfile(lineUserId);
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
      return {
        messageType: LineChatMessageType.STICKER,
        lastMessage: '[sticker]',
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
}
