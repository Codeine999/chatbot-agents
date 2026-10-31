import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { ChannelMessage } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../shared/guards/admin-auth.types';
import { LoadContextService } from '../chatbot/context/load-context.service';
import { CommerceScopeService } from '../commerce/commerce-scope.service';
import { UserSessionService } from '../users/session/user-session.service';
import { appUserId } from './app-session.service';
import { APP_LIMITS } from './app-message.config';
import { ADMIN_REPLY_METADATA } from './app-message.metadata';
import { sanitizeText } from './app-text';
import type {
  ListAppMessagesQueryDto,
  SendAppAdminMessageDto,
} from './dto/app-inbox.dto';
import {
  afterRoom,
  INBOX_ROOM_ORDER,
  isPagedInboxQuery,
  messageKeyset,
  pageInboxRooms,
  type ListInboxConversationsQuery,
} from '../../shared/inbox/inbox-page';

/** Newest rooms only; older ones are purged after the retention window anyway. */
const LIST_LIMIT = 200;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * Back-office view of App Message rooms. Shapes follow the LINE inbox
 * (LineConversation / LineChatHistory) so the dashboard can reuse its code;
 * every query is scoped to the admin's company.
 */
@Injectable()
export class AppInboxService {
  private readonly logger = new Logger(AppInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: CommerceScopeService,
    private readonly sessions: UserSessionService,
    private readonly context: LoadContextService,
  ) {}

  /**
   * Same order as the LINE inbox: rooms waiting for an admin first, then
   * newest. Any query parameter returns one `{ items, nextCursor }` page;
   * without any, the legacy array of the newest rooms is kept.
   */
  async listConversations(
    admin: AuthenticatedAdmin,
    query: ListInboxConversationsQuery = {},
  ) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const scope = this.roomScope(companyId);
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
  async countConversations(admin: AuthenticatedAdmin) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const scope = this.roomScope(companyId);
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
    conversationId: string,
  ) {
    const conversation = await this.requireConversation(admin, conversationId);
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

  private roomScope(companyId: string) {
    return {
      companyId,
      channel: 'APP' as const,
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
      channel: 'APP' as const,
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
    conversationId: string,
    query: ListAppMessagesQueryDto,
  ) {
    if (query.before && query.after)
      throw new BadRequestException('Use either before or after, not both');
    const before = this.parseDate(query.before, 'before');
    const after = this.parseDate(query.after, 'after');
    const limit = query.limit ?? (after ? 100 : 30);
    await this.requireConversation(admin, conversationId);
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
   * An admin reply. Safe to repeat with the same clientRequestId. Once stored,
   * the bot is muted for this guest (like a LINE admin reply) and a room that
   * was waiting for an admin goes back to open.
   */
  async sendAdminMessage(
    admin: AuthenticatedAdmin,
    conversationId: string,
    body: SendAppAdminMessageDto,
  ) {
    const text = sanitizeText(body.text);
    if (!text) throw new BadRequestException('Message is empty');
    const conversation = await this.requireConversation(admin, conversationId);

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
              status: 'SENT',
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
          // waiting_admin is the request queue; a real reply answers it.
          await tx.channelConversation.updateMany({
            where: { id: conversationId, status: 'waiting_admin' },
            data: { status: 'open' },
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

    // Also on a repeat: the first attempt may have stored the message and then
    // failed to mute.
    try {
      await this.sessions.mute(appUserId(conversation.contactId));
    } catch (error) {
      this.logger.warn(
        `mute after admin reply failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    return this.historyItem(message);
  }

  /** Stops the bot answering this guest until resume; admins can still reply. */
  async pauseBot(admin: AuthenticatedAdmin, conversationId: string) {
    const conversation = await this.requireConversation(admin, conversationId);
    await this.sessions.mute(
      appUserId(conversation.contactId),
      'PAUSE',
      APP_LIMITS.pauseBotSec,
    );
    return { botMode: 'paused' as const };
  }

  async resumeBot(admin: AuthenticatedAdmin, conversationId: string) {
    const conversation = await this.requireConversation(admin, conversationId);
    await this.sessions.resume(appUserId(conversation.contactId));
    await this.prisma.channelConversation.update({
      where: { id: conversationId },
      data: { status: 'open' },
    });
    await this.context.clear(conversationId);
    return { status: 'open' };
  }

  private async requireConversation(
    admin: AuthenticatedAdmin,
    conversationId: string,
  ) {
    const { companyId } = await this.scopes.forAdmin(admin);
    const conversation = await this.prisma.channelConversation.findFirst({
      where: { id: conversationId, companyId, channel: 'APP' },
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
      sentStatus: row.sender === 'USER' ? 'received' : 'sent',
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
