import { createHash, randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import type { ChannelMessage } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  channelUserId,
  type StoredChannelKind,
} from '../../../../shared/channel/channel-kinds';
import type { AuthenticatedAdmin } from '../../../../shared/guards/admin-auth.types';
import {
  afterRoom,
  INBOX_ROOM_ORDER,
  isPagedInboxQuery,
  messageKeyset,
  pageInboxRooms,
  type ListInboxConversationsQuery,
} from '../../../../shared/inbox/inbox-page';
import { LoadContextService } from '../../../chatbot/context/load-context.service';
import { CommerceScopeService } from '../../../commerce/commerce-scope.service';
import { UserSessionService } from '../../../session/user-session.service';
import { ChannelConnectorRegistry } from '../channel-connector.registry';
import { ADMIN_REPLY_METADATA } from '../channel-message.metadata';
import {
  ChannelDeliveryError,
  ChannelOutboundService,
} from '../channel-outbound.service';
import { sanitizeText } from '../channel-text';
import type {
  ListChannelMessagesQueryDto,
  SendChannelAdminMessageDto,
} from './channel-inbox.dto';

/** An admin pause lasts until resume, at most a week. */
export const CHANNEL_PAUSE_BOT_SEC = 7 * 86_400;

/** Newest rooms only; older App rooms are purged after the retention window anyway. */
const LIST_LIMIT = 200;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * Back-office view of channel* rooms (App, Facebook, ...). Shapes follow the
 * LINE inbox (LineConversation / LineChatHistory) so the dashboard can reuse
 * its code; every query is scoped to the admin's company and one channel.
 */
@Injectable()
export class ChannelInboxService {
  private readonly logger = new Logger(ChannelInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: CommerceScopeService,
    private readonly sessions: UserSessionService,
    private readonly context: LoadContextService,
    private readonly connectors: ChannelConnectorRegistry,
    private readonly outbound: ChannelOutboundService,
  ) {}

  /**
   * Same order as the LINE inbox: rooms waiting for an admin first, then
   * newest. Any query parameter returns one `{ items, nextCursor }` page;
   * without any, the legacy array of the newest rooms is kept.
   */
  async listConversations(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    query: ListInboxConversationsQuery = {},
  ) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const scope = this.roomScope(companyId, channel);
    const include = {
      contact: { select: { id: true, displayName: true, metadata: true } },
    } as const;

    if (isPagedInboxQuery(query)) {
      const page = await pageInboxRooms(query, (waiting, after, take) =>
        this.prisma.channelConversation.findMany({
          where: {
            AND: [
              scope,
              { status: waiting ? 'waiting_admin' : { not: 'waiting_admin' } },
              query.unread ? { unreadCount: { gt: 0 } } : {},
              query.q
                ? {
                    contact: {
                      displayName: { contains: query.q, mode: 'insensitive' },
                    },
                  }
                : {},
              afterRoom(after),
            ],
          },
          orderBy: INBOX_ROOM_ORDER,
          take,
          include,
        }),
      );
      return { ...page, items: page.items.map((row) => this.roomItem(row)) };
    }

    const rows = await this.prisma.channelConversation.findMany({
      where: scope,
      orderBy: INBOX_ROOM_ORDER,
      take: LIST_LIMIT,
      include,
    });
    const view = rows.map((row) => this.roomItem(row));
    return [
      ...view.filter((row) => row.status === 'waiting_admin'),
      ...view.filter((row) => row.status !== 'waiting_admin'),
    ];
  }

  /** Totals for the inbox tabs; independent of the loaded page. */
  async countConversations(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
  ) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const scope = this.roomScope(companyId, channel);
    const [all, unread, waitingAdmin] = await Promise.all([
      this.prisma.channelConversation.count({ where: scope }),
      this.prisma.channelConversation.count({
        where: { ...scope, unreadCount: { gt: 0 } },
      }),
      this.prisma.channelConversation.count({
        where: { ...scope, status: 'waiting_admin' },
      }),
    ]);
    return { all, unread, waitingAdmin };
  }

  /** Clears the unread badge once an admin has the room open. */
  async markConversationRead(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
  ) {
    const conversation = await this.requireConversation(
      admin,
      channel,
      conversationId,
    );
    await this.prisma.channelConversation.updateMany({
      where: {
        id: conversation.id,
        companyId: conversation.companyId,
        unreadCount: { gt: 0 },
      },
      data: { unreadCount: 0 },
    });
    return { id: conversation.id, unreadCount: 0 };
  }

  private roomScope(companyId: string, channel: StoredChannelKind) {
    return {
      companyId,
      channel,
      // A room exists from the first message attempt; hide it until a
      // message is actually stored.
      lastMessage: { not: '' },
    };
  }

  private roomItem(
    row: Prisma.ChannelConversationGetPayload<{
      include: {
        contact: { select: { id: true; displayName: true; metadata: true } };
      };
    }>,
  ) {
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      lastMessage: row.lastMessage,
      lastMessageAt: row.lastMessageAt,
      unreadCount: row.unreadCount,
      createdAt: row.createdAt,
      contact: row.contact,
    };
  }

  async getMessages(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
    query: ListChannelMessagesQueryDto,
  ) {
    if (query.before && query.after)
      throw new BadRequestException('Use either before or after, not both');
    const before = this.parseDate(query.before, 'before');
    const after = this.parseDate(query.after, 'after');
    const limit = query.limit ?? (after ? 100 : 30);
    await this.requireConversation(admin, channel, conversationId);
    const keyset = messageKeyset(before, query.beforeId, after, query.afterId);

    if (after) {
      const rows = await this.prisma.channelMessage.findMany({
        where: { conversationId, ...keyset },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      return rows.map((row) => this.historyItem(row));
    }
    const rows = await this.prisma.channelMessage.findMany({
      where: { conversationId, ...keyset },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map((row) => this.historyItem(row));
  }

  /**
   * An admin reply. Safe to repeat with the same clientRequestId. On a push
   * channel (Facebook) it is sent through the connector; only once the
   * platform accepted it is the bot muted and a waiting room set back to
   * open, like a LINE admin reply. On App it is stored and read by polling.
   */
  async sendAdminMessage(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
    body: SendChannelAdminMessageDto,
  ) {
    const text = sanitizeText(body.text);
    if (!text) throw new BadRequestException('Message is empty');
    const conversation = await this.requireConversation(
      admin,
      channel,
      conversationId,
    );
    const pushed = Boolean(this.connectors.find(channel));

    // Scoped per admin so two admins cannot collide on one clientRequestId.
    const clientMessageId = `admin:${createHash('sha256')
      .update(`${admin.id}|${body.clientRequestId ?? randomUUID()}`)
      .digest('hex')
      .slice(0, 40)}`;

    let message = await this.findAdminMessage(conversationId, clientMessageId);
    if (!message) {
      try {
        message = await this.prisma.$transaction(async (tx) => {
          const created = await tx.channelMessage.create({
            data: {
              companyId: conversation.companyId,
              conversationId,
              contactId: conversation.contactId,
              sender: 'ADMIN',
              text,
              status: pushed ? 'PENDING' : 'SENT',
              clientMessageId,
              sentByAdminId: admin.id,
              metadata: ADMIN_REPLY_METADATA,
            },
          });
          await tx.channelConversation.update({
            where: { id: conversationId },
            data: {
              lastMessage: text.slice(0, 200),
              lastMessageAt: created.createdAt,
            },
          });
          return created;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        message = await this.findAdminMessage(conversationId, clientMessageId);
      }
    }
    if (!message) throw new NotFoundException('Message not found');
    if (message.text !== text)
      throw new BadRequestException(
        'clientRequestId was already used for different text',
      );

    if (pushed && message.status !== 'SENT') {
      const state = await this.push(message.id);
      message = await this.prisma.channelMessage.findUniqueOrThrow({
        where: { id: message.id },
      });
      if (state === 'FAILED')
        throw new BadGatewayException(
          `Message was not delivered (${message.lastError ?? 'FAILED'})`,
        );
      // BUSY: another request is sending it; report it as pending.
      if (state !== 'SENT') return this.historyItem(message);
    }

    // waiting_admin is the request queue; a delivered reply answers it.
    await this.prisma.channelConversation.updateMany({
      where: { id: conversationId, status: 'waiting_admin' },
      data: { status: 'open' },
    });
    // Also on a repeat: the first attempt may have stored the message and then
    // failed to mute.
    try {
      await this.sessions.holdForAdmin(
        channelUserId(channel, conversation.contactId),
      );
    } catch (error) {
      this.logger.warn(
        `mute after admin reply failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    return this.historyItem(message);
  }

  /** Stops the bot answering this customer until resume; admins can still reply. */
  async pauseBot(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
  ) {
    const conversation = await this.requireConversation(
      admin,
      channel,
      conversationId,
    );
    await this.sessions.mute(
      channelUserId(channel, conversation.contactId),
      'PAUSE',
      CHANNEL_PAUSE_BOT_SEC,
    );
    return { botMode: 'paused' as const };
  }

  /**
   * As after an admin reply: bot quiet for AUTO_MUTE_WHEN_REPLY, then automatic
   * again, and an open admin request (waiting_admin) is closed.
   */
  async holdBotForAdmin(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
  ) {
    const conversation = await this.requireConversation(
      admin,
      channel,
      conversationId,
    );
    const userId = channelUserId(channel, conversation.contactId);
    await this.sessions.mute(userId, 'ADMIN');
    await this.prisma.channelConversation.updateMany({
      where: { id: conversation.id, status: 'waiting_admin' },
      data: { status: 'open' },
    });
    const mute = await this.sessions.getMuteState(userId);
    return {
      status: 'open' as const,
      botMode: 'admin' as const,
      botMuteUntil: mute?.expiresAt?.toISOString() ?? null,
    };
  }

  async resumeBot(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
  ) {
    const conversation = await this.requireConversation(
      admin,
      channel,
      conversationId,
    );
    await this.sessions.resume(channelUserId(channel, conversation.contactId));
    await this.prisma.channelConversation.update({
      where: { id: conversationId },
      data: { status: 'open' },
    });
    await this.context.clear(conversationId);
    return { status: 'open' };
  }

  /** A retryable platform failure is reported as 503; the admin retries the same request. */
  private async push(messageId: string) {
    try {
      return await this.outbound.deliver(messageId, { retryFailed: true });
    } catch (error) {
      if (error instanceof ChannelDeliveryError)
        throw new ServiceUnavailableException(
          'The platform did not accept the message; try again',
        );
      throw error;
    }
  }

  private async requireConversation(
    admin: AuthenticatedAdmin,
    channel: StoredChannelKind,
    conversationId: string,
  ) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const conversation = await this.prisma.channelConversation.findFirst({
      where: { id: conversationId, companyId, channel },
      select: { id: true, companyId: true, contactId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  private findAdminMessage(conversationId: string, clientMessageId: string) {
    return this.prisma.channelMessage.findUnique({
      where: {
        conversationId_clientMessageId: { conversationId, clientMessageId },
      },
    });
  }

  /** Same field names as LineChatHistory; internal bookkeeping stays out. */
  private historyItem(row: ChannelMessage) {
    return {
      id: row.id,
      conversationId: row.conversationId,
      sender: row.sender,
      messageType: row.messageType,
      text: row.text,
      sentStatus: sentStatus(row),
      metadata: row.metadata,
      createdAt: row.createdAt,
    };
  }

  private parseDate(value: string | undefined, name: string): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`Invalid ${name} date`);
    return date;
  }
}

function sentStatus(row: Pick<ChannelMessage, 'sender' | 'status'>) {
  if (row.sender === 'USER') return 'received';
  if (row.status === 'FAILED') return 'failed';
  return row.status === 'PENDING' || row.status === 'SENDING'
    ? 'pending'
    : 'sent';
}
