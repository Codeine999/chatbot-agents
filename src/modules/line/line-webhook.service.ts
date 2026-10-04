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
import { UserSessionService } from '../chatbot/user-session.service';

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

  async listConversations() {
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

    const waitingAdmin = conversations.filter(
      (conversation) => conversation.status === 'waiting_admin',
    );
    const otherConversations = conversations.filter(
      (conversation) => conversation.status !== 'waiting_admin',
    );
    return [...waitingAdmin, ...otherConversations];
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
    if (message) return message;
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
