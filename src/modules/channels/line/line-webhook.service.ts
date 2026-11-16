import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LineChatMessageType,
  LineChatSender,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MessageProcessorService } from '../../conversation/message/message-processor.service';
import { LineChannelAdapter } from './line-channel.adapter';
import { LoadContextService } from '../../chatbot/context/load-context.service';
import type { LineWebhookEvent } from './dto/line';
import type {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import { LineDeliveryService } from './delivery/line-delivery.service';
import { randomUUID } from 'node:crypto';
import {
  BOT_PAUSE_TTL_SEC,
  UserSessionService,
} from '../../session/user-session.service';
import * as claims from './worker/line-webhook-claim';
import {
  afterRoom,
  INBOX_ROOM_ORDER,
  messageKeyset,
  pageInboxRooms,
  type ListInboxConversationsQuery,
} from '../../../shared/inbox/inbox-page';

/** Rooms per page of the LINE inbox when the dashboard sends no `limit`. */
const LINE_INBOX_PAGE_SIZE = 20;

@Injectable()
export class LineWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageProcessor: MessageProcessorService,
    private readonly channelAdapter: LineChannelAdapter,
    private readonly loadContextService: LoadContextService,
    private readonly deliveryService: LineDeliveryService,
    private readonly sessions: UserSessionService,
  ) {}

  /** Keep the worker entry point stable while messaging owns turn orchestration. */
  async processEvent(
    event: LineWebhookEvent,
    claimOwner?: string,
  ): Promise<void> {
    await this.messageProcessor.process(event, this.channelAdapter, claimOwner);
  }

  saveIncomingEvent(event: LineWebhookEvent) {
    return this.channelAdapter.saveIncomingEvent(event);
  }

  /**
   * Always one `{ items, nextCursor }` page (LINE_INBOX_PAGE_SIZE rooms unless
   * `limit` is sent), so a large inbox never loads every room at once.
   */
  async listConversations(query: ListInboxConversationsQuery = {}) {
    const paged = { ...query, limit: query.limit ?? LINE_INBOX_PAGE_SIZE };
    const page = await pageInboxRooms(paged, (waiting, after, take) =>
      this.prisma.lineConversation.findMany({
        where: {
          AND: [
            { status: waiting ? 'waiting_admin' : { not: 'waiting_admin' } },
            query.unread ? { unreadCount: { gt: 0 } } : {},
            query.q
              ? {
                  lineMember: {
                    displayName: { contains: query.q, mode: 'insensitive' },
                  },
                }
              : {},
            afterRoom(after),
          ],
        },
        orderBy: INBOX_ROOM_ORDER,
        take,
        include: { lineMember: true },
      }),
    );
    return { ...page, items: await this.withBotMode(page.items) };
  }

  /** Totals for the inbox tabs; independent of the loaded page. */
  async countConversations() {
    const [all, unread, waitingAdmin] = await Promise.all([
      this.prisma.lineConversation.count(),
      this.prisma.lineConversation.count({
        where: { unreadCount: { gt: 0 } },
      }),
      this.prisma.lineConversation.count({
        where: { status: 'waiting_admin' },
      }),
    ]);
    return { all, unread, waitingAdmin };
  }

  /** Clears the unread badge once an admin has the room open. */
  async markConversationRead(conversationId: string) {
    const cleared = await this.prisma.lineConversation.updateMany({
      where: { id: conversationId, unreadCount: { gt: 0 } },
      data: { unreadCount: 0 },
    });
    if (!cleared.count) {
      const exists = await this.prisma.lineConversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('LINE conversation not found');
    }
    return { id: conversationId, unreadCount: 0 };
  }

  // Mute lives in Redis and is the only source of truth for the bot mode,
  // so the list carries it to keep every admin's view in sync.
  private withBotMode<T extends { lineMember: { lineUserId: string } }>(
    conversations: T[],
  ) {
    return Promise.all(
      conversations.map(async (conversation) => {
        const mute = await this.sessions.getMuteState(
          conversation.lineMember.lineUserId,
        );
        return {
          ...conversation,
          botMode: mute ? (mute.mode === 'ADMIN' ? 'admin' : 'paused') : 'auto',
          botMuteUntil: mute?.expiresAt?.toISOString() ?? null,
        };
      }),
    );
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

    const keyset = messageKeyset(before, query.beforeId, after, query.afterId);

    if (after) {
      const messages = await this.prisma.lineChatHistory.findMany({
        where: { conversationId, ...keyset },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });

      return this.withAdminUsernames(messages);
    }

    const messages = await this.prisma.lineChatHistory.findMany({
      where: { conversationId, ...keyset },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return this.withAdminUsernames(messages.reverse());
  }

  /**
   * Replaces `sentByAdminId` with the admin's username so the dashboard can
   * show who replied. Null when no admin sent it (bot/customer) or the admin
   * no longer exists; the dashboard treats null as an AI reply.
   */
  private async withAdminUsernames<T extends { sentByAdminId: string | null }>(
    messages: T[],
  ): Promise<T[]> {
    const ids = [
      ...new Set(
        messages
          .map((message) => message.sentByAdminId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) return messages;

    const admins = await this.prisma.adminMember.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true },
    });
    const usernames = new Map(admins.map((admin) => [admin.id, admin.username]));

    return messages.map((message) => ({
      ...message,
      sentByAdminId: message.sentByAdminId
        ? (usernames.get(message.sentByAdminId) ?? null)
        : null,
    }));
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

    const deliveryKey = `admin:${sentByAdminId}:${conversationId}:${body.clientRequestId ?? randomUUID()}`;
    const delivery = await this.prisma.lineDelivery.upsert({
      where: { key: deliveryKey },
      update: {},
      create: {
        key: deliveryKey,
        lineUserId: conversation.lineMember.lineUserId,
        conversationId, lineMemberId: conversation.lineMemberId,
        adminMemberId: sentByAdminId, text: body.text, method: 'PUSH',
      },
    });
    if (delivery.text !== body.text) throw new BadRequestException('clientRequestId was already used for different text');
    await this.deliveryService.deliver(delivery.id);
    const message = await this.prisma.lineChatHistory.findUnique({ where: { deliveryId: delivery.id } });
    if (message) return (await this.withAdminUsernames([message]))[0];
    const current = await this.prisma.lineDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    return { id: current.id, deliveryId: current.id, text: current.text, sentStatus: current.status.toLowerCase() };
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

  async resumeBot(conversationId: string) {
    const conversation = await this.prisma.lineConversation.findUniqueOrThrow({ where: { id: conversationId }, include: { lineMember: true } });
    await this.sessions.resume(conversation.lineMember.lineUserId);
    await this.prisma.lineConversation.update({ where: { id: conversationId }, data: { status: 'open' } });
    await this.loadContextService.clear(conversationId);
    return { status: 'open' };
  }

  /**
   * Stops automatic replies to this one customer until resume-bot (or
   * BOT_PAUSE_TTL_SEC). Incoming messages are still stored; admins can still
   * reply, and an admin reply keeps the pause instead of shortening it.
   */
  async pauseBot(conversationId: string) {
    const lineUserId = await this.lineUserIdOf(conversationId);
    await this.sessions.mute(lineUserId, 'PAUSE', BOT_PAUSE_TTL_SEC);
    return this.botState(lineUserId);
  }

  /**
   * Marks the customer as handled by an admin, exactly as an admin reply does:
   * the bot stays quiet for AUTO_MUTE_WHEN_REPLY, then answers again, and an
   * open admin request (waiting_admin) is closed.
   */
  async holdBotForAdmin(conversationId: string) {
    const lineUserId = await this.lineUserIdOf(conversationId);
    await this.sessions.mute(lineUserId, 'ADMIN');
    await this.prisma.lineConversation.updateMany({
      where: { id: conversationId, status: 'waiting_admin' },
      data: { status: 'open' },
    });
    return { status: 'open' as const, ...(await this.botState(lineUserId)) };
  }

  private async lineUserIdOf(conversationId: string): Promise<string> {
    const conversation = await this.prisma.lineConversation.findUnique({
      where: { id: conversationId },
      select: { lineMember: { select: { lineUserId: true } } },
    });
    if (!conversation)
      throw new NotFoundException('LINE conversation not found');
    return conversation.lineMember.lineUserId;
  }

  /** Same `botMode` / `botMuteUntil` fields as the conversation list. */
  private async botState(lineUserId: string) {
    const mute = await this.sessions.getMuteState(lineUserId);
    return {
      botMode: mute ? (mute.mode === 'ADMIN' ? 'admin' : 'paused') : 'auto',
      botMuteUntil: mute?.expiresAt?.toISOString() ?? null,
    };
  }

  listDeliveries() {
    return this.prisma.lineDelivery.findMany({
      where: { status: { in: ['PENDING', 'SENDING', 'FAILED', 'UNKNOWN'] } },
      select: { id: true, conversationId: true, status: true, method: true, attempts: true, lastError: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  listFailedWebhookEvents() {
    return this.prisma.processedLineWebhookEvent.findMany({
      where: { status: { in: ['RETRY', 'FAILED'] } },
      select: { webhookEventId: true, status: true, attempts: true, lastError: true, processedAt: true },
      orderBy: { processedAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Claims a webhook event for processing by inserting its id under a
   * unique constraint. Returns false when the event was already claimed,
   * so a duplicate delivery is skipped and never replied to twice.
   */
  async claimWebhookEvent(event: LineWebhookEvent): Promise<string | null> {
    return claims.claimWebhookEvent(this.prisma, event);
  }

  async renewWebhookLease(webhookEventId: string, owner: string) {
    return claims.renewWebhookLease(this.prisma, webhookEventId, owner);
  }

  async finishWebhookEvent(
    webhookEventId: string,
    owner: string,
    error?: unknown,
  ) {
    return claims.finishWebhookEvent(this.prisma, webhookEventId, owner, error);
  }

  async recoverableWebhookEvents(): Promise<LineWebhookEvent[]> {
    return claims.recoverableWebhookEvents(this.prisma);
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
