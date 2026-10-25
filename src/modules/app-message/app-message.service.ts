import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { ChannelMessage } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageProcessorService } from '../events/message/message-processor.service';
import { AppAbuseService } from './app-abuse.service';
import { AppChannelAdapter } from './app-channel.adapter';
import { AppApiException, appUnavailable } from './app-errors';
import { APP_LIMITS } from './app-message.config';
import { publicSource } from './app-message.metadata';
import type { AppGuestContext } from './app-request';
import { AppSessionService } from './app-session.service';
import { sanitizeText } from './app-text';
import type {
  ListMessagesQueryDto,
  SendMessageDto,
} from './dto/app-message.dto';

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

const busy = () =>
  new AppApiException(
    409,
    'APP_CONVERSATION_BUSY',
    'Your previous message is still being answered',
    2,
  );

@Injectable()
export class AppMessageService {
  private readonly logger = new Logger(AppMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly abuse: AppAbuseService,
    private readonly processor: MessageProcessorService,
    private readonly adapter: AppChannelAdapter,
    private readonly sessions: AppSessionService,
  ) {}

  /**
   * One guest message, answered in the same request. Resending the same
   * clientMessageId returns the first answer; the model is not called (or
   * billed) again. A turn that crashed is redone once its room lock expires,
   * under the same turnId, so billing settles it once.
   */
  async send(guest: AppGuestContext, dto: SendMessageDto) {
    const text = sanitizeText(dto.text);
    if (!text)
      throw new AppApiException(400, 'APP_VALIDATION', 'Message is empty');
    if (text.length > APP_LIMITS.textMaxChars)
      throw new AppApiException(400, 'APP_VALIDATION', 'Message is too long');
    await this.abuse.assertMessage(guest, text);

    const conversationId = await this.ensureConversation(guest);
    const existing = await this.findByClientId(
      conversationId,
      dto.clientMessageId,
    );
    if (existing) {
      if (existing.text !== text)
        throw new AppApiException(
          409,
          'APP_CLIENT_MESSAGE_ID_REUSED',
          'clientMessageId was already used for a different message',
        );
      if (existing.status !== 'PROCESSING')
        return this.result(guest, conversationId, existing.id);
    }
    const messageId = existing?.id ?? randomUUID();

    // One turn per room at a time, across instances. Also what a retry of a
    // message that is still being answered runs into.
    const now = new Date();
    const locked = await this.prisma.channelConversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ activeUntil: null }, { activeUntil: { lt: now } }],
      },
      data: {
        activeTurnId: messageId,
        activeUntil: new Date(now.getTime() + APP_LIMITS.turnLockSec * 1000),
      },
    });
    if (!locked.count) throw busy();

    try {
      if (!existing) {
        try {
          // The inbound row and its unread increment commit together, so a
          // repeated request never counts the same message twice.
          await this.prisma.$transaction([
            this.prisma.channelMessage.create({
              data: {
                id: messageId,
                companyId: guest.companyId,
                conversationId,
                contactId: guest.contactId,
                sender: 'USER',
                text,
                clientMessageId: dto.clientMessageId,
                status: 'PROCESSING',
                metadata: dto.metadata ?? Prisma.JsonNull,
              },
            }),
            this.prisma.channelConversation.update({
              where: { id: conversationId },
              data: {
                lastMessage: text.slice(0, 200),
                lastMessageAt: now,
                unreadCount: { increment: 1 },
              },
            }),
            this.prisma.channelContact.update({
              where: { id: guest.contactId },
              data: { lastActiveAt: now },
            }),
          ]);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // An identical request finished between our read and our lock.
          const winner = await this.findByClientId(
            conversationId,
            dto.clientMessageId,
          );
          if (winner?.text === text && winner.status !== 'PROCESSING')
            return await this.result(guest, conversationId, winner.id);
          throw busy();
        }
      }

      try {
        await this.processor.process(
          {
            messageId,
            conversationId,
            contactId: guest.contactId,
            companyId: guest.companyId,
            text,
          },
          this.adapter,
          messageId,
        );
      } catch (error) {
        // Name only: provider messages can echo the customer's text.
        this.logger.error(
          `app turn failed message=${messageId} error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        throw appUnavailable();
      }
      return await this.result(guest, conversationId, messageId);
    } finally {
      await this.prisma.channelConversation
        .updateMany({
          where: { id: conversationId, activeTurnId: messageId },
          data: { activeTurnId: null, activeUntil: null },
        })
        .catch(() => undefined); // the lock also expires on its own
    }
  }

  /** History for the session's own room, oldest first. Poll with the returned cursor. */
  async list(guest: AppGuestContext, query: ListMessagesQueryDto) {
    // The room comes from the session only; clients never name a conversation.
    const conversation = await this.prisma.channelConversation.findUnique({
      where: { contactId: guest.contactId },
      select: { id: true },
    });
    if (!conversation) return { items: [], nextCursor: query.after ?? null };

    const after = query.after ? this.decodeCursor(query.after) : null;
    const rows = await this.prisma.channelMessage.findMany({
      where: {
        conversationId: conversation.id,
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
    });
    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.item(row)),
      nextCursor: last ? this.encodeCursor(last) : (query.after ?? null),
    };
  }

  private async result(
    guest: AppGuestContext,
    conversationId: string,
    messageId: string,
  ) {
    const [inbound, reply, conversation, botMode] = await Promise.all([
      this.prisma.channelMessage.findUniqueOrThrow({
        where: { id: messageId },
      }),
      this.prisma.channelMessage.findUnique({
        where: { replyToId: messageId },
      }),
      this.prisma.channelConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { status: true },
      }),
      this.sessions.botMode(guest.contactId),
    ]);
    if (inbound.status === 'PROCESSING') throw appUnavailable();

    return {
      message: this.item(inbound),
      replies: reply ? [this.item(reply)] : [],
      // Built from our own records only: no costs, no wallet state.
      meta: {
        status: inbound.status === 'ANSWERED' ? 'ANSWERED' : 'NO_REPLY',
        source: reply?.source
          ? publicSource(reply.source as Parameters<typeof publicSource>[0])
          : null,
        handoff: conversation.status === 'waiting_admin',
        botMode,
      },
    };
  }

  private item(row: ChannelMessage) {
    return {
      id: row.id,
      sender: row.sender.toLowerCase(),
      text: row.text,
      metadata: row.metadata,
      createdAt: row.createdAt,
    };
  }

  private findByClientId(conversationId: string, clientMessageId: string) {
    return this.prisma.channelMessage.findUnique({
      where: {
        conversationId_clientMessageId: { conversationId, clientMessageId },
      },
    });
  }

  /** Created on the first message, not with the session, so idle guests leave no rooms. */
  private async ensureConversation(guest: AppGuestContext): Promise<string> {
    try {
      const row = await this.prisma.channelConversation.upsert({
        where: { contactId: guest.contactId },
        create: {
          companyId: guest.companyId,
          channel: 'APP',
          contactId: guest.contactId,
          lastMessage: '',
          lastMessageAt: new Date(),
        },
        update: {},
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.channelConversation.findUniqueOrThrow({
        where: { contactId: guest.contactId },
        select: { id: true },
      });
      return row.id;
    }
  }

  private encodeCursor(row: Pick<ChannelMessage, 'createdAt' | 'id'>): string {
    return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString(
      'base64url',
    );
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const createdAt = new Date(iso);
    if (
      !iso ||
      !id ||
      Number.isNaN(createdAt.getTime()) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    )
      throw new AppApiException(400, 'APP_VALIDATION', 'Invalid cursor');
    return { createdAt, id };
  }
}
