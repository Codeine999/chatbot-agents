import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { StoredChannelKind } from '../../../shared/channel/channel-kinds';
import type { ChatResponse } from '../../../shared/contracts/chat.types';
import { MessageProcessorService } from '../../conversation/message/message-processor.service';
import type { InboundMessage } from './channel-connector';
import {
  CHANNEL_TURN_LOCK_SEC,
  ChannelStoreAdapter,
} from './channel-store.adapter';
import { sanitizeText } from './channel-text';

/** The room is answering an earlier message; the queue retries with backoff. */
export class ChannelRoomBusyError extends Error {
  constructor() {
    super('channel room busy');
    this.name = 'ChannelRoomBusyError';
  }
}

const MAX_TEXT = 2000;
const UNSUPPORTED_REPLY: ChatResponse = {
  text: 'ขออภัย ตอนนี้ระบบตอบได้เฉพาะข้อความตัวอักษร รบกวนพิมพ์คำถามเป็นข้อความนะคะ',
  source: 'SYSTEM',
  contextPolicy: 'EXCLUDE',
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

export type InboundContact = Readonly<{ contactId: string }>;

/**
 * Turns one verified platform message into a stored inbound row and runs it
 * through the shared MessageProcessorService, exactly once per
 * (conversation, externalMessageId), one turn per room across instances.
 */
@Injectable()
export class ChannelInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: MessageProcessorService,
    private readonly store: ChannelStoreAdapter,
  ) {}

  /** The customer's row; created on first contact. Never trusts a payload company. */
  async contact(
    kind: StoredChannelKind,
    companyId: string,
    message: InboundMessage,
  ): Promise<InboundContact> {
    const where = {
      companyId_channel_externalUserId: {
        companyId,
        channel: kind,
        externalUserId: message.externalUserId,
      },
    };
    try {
      const row = await this.prisma.channelContact.upsert({
        where,
        // `accountId` is written by the server, used to address replies.
        create: {
          companyId,
          channel: kind,
          externalUserId: message.externalUserId,
          metadata: { accountId: message.accountId },
        },
        update: {},
        select: { id: true },
      });
      return { contactId: row.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.channelContact.findUniqueOrThrow({
        where,
        select: { id: true },
      });
      return { contactId: row.id };
    }
  }

  async handle(
    kind: StoredChannelKind,
    companyId: string,
    { contactId }: InboundContact,
    message: InboundMessage,
  ): Promise<void> {
    const text = message.unsupported
      ? '[attachment]'
      : sanitizeText(message.text).slice(0, MAX_TEXT);
    if (!text) return;

    const conversationId = await this.conversation(kind, companyId, contactId);
    const existing = await this.prisma.channelMessage.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId,
          externalMessageId: message.externalMessageId,
        },
      },
      select: { id: true, status: true },
    });
    // Decided without a reply (muted, empty): a redelivery must not answer it.
    if (existing?.status === 'NO_REPLY') return;
    const messageId = existing?.id ?? randomUUID();

    const now = new Date();
    const locked = await this.prisma.channelConversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ activeUntil: null }, { activeUntil: { lt: now } }],
      },
      data: {
        activeTurnId: messageId,
        activeUntil: new Date(now.getTime() + CHANNEL_TURN_LOCK_SEC * 1000),
      },
    });
    if (!locked.count) throw new ChannelRoomBusyError();

    try {
      if (!existing) {
        try {
          // The inbound row and its unread increment commit together, so a
          // redelivered webhook never counts the same message twice.
          await this.prisma.$transaction([
            this.prisma.channelMessage.create({
              data: {
                id: messageId,
                companyId,
                conversationId,
                contactId,
                sender: 'USER',
                messageType: message.unsupported ? 'UNSUPPORTED' : 'TEXT',
                text,
                externalMessageId: message.externalMessageId,
                status: 'PROCESSING',
                createdAt: now,
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
              where: { id: contactId },
              data: { lastActiveAt: now },
            }),
          ]);
        } catch (error) {
          // Another worker stored it between our read and our lock.
          if (isUniqueViolation(error)) throw new ChannelRoomBusyError();
          throw error;
        }
      }

      // Answered already: this resumes a delivery that has not finished.
      await this.processor.process(
        {
          channel: kind,
          messageId,
          conversationId,
          contactId,
          companyId,
          text,
          response: message.unsupported ? UNSUPPORTED_REPLY : undefined,
        },
        this.store,
        messageId,
      );
    } finally {
      await this.prisma.channelConversation
        .updateMany({
          where: { id: conversationId, activeTurnId: messageId },
          data: { activeTurnId: null, activeUntil: null },
        })
        .catch(() => undefined); // the lock also expires on its own
    }
  }

  private async conversation(
    kind: StoredChannelKind,
    companyId: string,
    contactId: string,
  ): Promise<string> {
    try {
      const row = await this.prisma.channelConversation.upsert({
        where: { contactId },
        create: {
          companyId,
          channel: kind,
          contactId,
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
        where: { contactId },
        select: { id: true },
      });
      return row.id;
    }
  }
}
