import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LineChatMessageType,
  LineChatSender,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageProcessorService } from '../events/message/message-processor.service';
import { LineChannelAdapter } from './line-channel.adapter';
import { LoadContextService } from '../chatbot/context/load-context.service';
import type { LineWebhookEvent } from './dto/line';
import type {
  GetLineMessagesQueryDto,
  SendLineMessageDto,
} from './dto/line-admin.dto';
import { LineDeliveryService } from './line-delivery.service';
import { randomUUID } from 'node:crypto';
import { UserSessionService } from '../users/session/user-session.service';
import {
  afterRoom,
  INBOX_ROOM_ORDER,
  isPagedInboxQuery,
  messageKeyset,
  pageInboxRooms,
  type ListInboxConversationsQuery,
} from '../../shared/inbox/inbox-page';

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
   * Any query parameter returns one `{ items, nextCursor }` page; without
   * any, the legacy full array is kept for dashboards not yet paging.
   */
  async listConversations(query: ListInboxConversationsQuery = {}) {
    if (!isPagedInboxQuery(query)) return this.listAllConversations();

    const page = await pageInboxRooms(query, (waiting, after, take) =>
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

  private async listAllConversations() {
    const conversations = await this.prisma.lineConversation.findMany({
      orderBy: [
        {
          lastMessageAt: 'desc',
        },
        {
          updatedAt: 'desc',
        },
        {
          id: 'desc',
        },
      ],
      include: {
        lineMember: true,
      },
    });

    const withBotMode = await this.withBotMode(conversations);

    const waitingAdmin = withBotMode.filter(
      (conversation) => conversation.status === 'waiting_admin',
    );
    const otherConversations = withBotMode.filter(
      (conversation) => conversation.status !== 'waiting_admin',
    );
    return [...waitingAdmin, ...otherConversations];
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
    const owner = randomUUID();
    const now = new Date();
    try {
      await this.prisma.processedLineWebhookEvent.create({
        data: { webhookEventId: event.webhookEventId, event: event as unknown as Prisma.InputJsonValue, status: 'RETRY', leaseUntil: now },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
    const claimed = await this.prisma.processedLineWebhookEvent.updateMany({
      where: { webhookEventId: event.webhookEventId, status: { in: ['RETRY', 'PROCESSING'] },
        leaseUntil: { lte: now }, attempts: { lt: 5 } },
      data: { status: 'PROCESSING', leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000), attempts: { increment: 1 } },
    });
    return claimed.count ? owner : null;
  }

  async renewWebhookLease(webhookEventId: string, owner: string) {
    await this.prisma.processedLineWebhookEvent.updateMany({
      where: { webhookEventId, leaseOwner: owner, status: 'PROCESSING' },
      data: { leaseUntil: new Date(Date.now() + 120_000) },
    });
  }

  async finishWebhookEvent(webhookEventId: string, owner: string, error?: unknown) {
    await this.prisma.processedLineWebhookEvent.updateMany({
      where: { webhookEventId, leaseOwner: owner, status: 'PROCESSING' },
      data: {
        status: error ? 'RETRY' : 'COMPLETED', leaseOwner: null,
        leaseUntil: new Date(Date.now() + 10_000),
        lastError: error ? String(error).slice(0, 1000) : null,
      },
    });
  }

  async recoverableWebhookEvents(): Promise<LineWebhookEvent[]> {
    const now = new Date();
    await this.prisma.processedLineWebhookEvent.updateMany({
      where: { status: { in: ['PROCESSING', 'RETRY'] }, attempts: { gte: 5 }, leaseUntil: { lte: now } },
      data: { status: 'FAILED', leaseOwner: null },
    });
    const rows = await this.prisma.processedLineWebhookEvent.findMany({
      where: { status: { in: ['PROCESSING', 'RETRY'] }, attempts: { lt: 5 }, leaseUntil: { lte: now } },
      orderBy: { processedAt: 'asc' }, take: 20,
    });
    return rows.filter(row => row.event).map(row => row.event as unknown as LineWebhookEvent);
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
