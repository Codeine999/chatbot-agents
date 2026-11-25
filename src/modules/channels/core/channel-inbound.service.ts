import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { StoredChannelKind } from '../../../shared/channel/channel-kinds';
import type { ChatResponse } from '../../../shared/contracts/chat.types';
import { MessageProcessorService } from '../../conversation/message/message-processor.service';
import type { InboundMessage } from './channel-connector';
import { ChannelConnectorRegistry } from './channel-connector.registry';
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

/** A found profile is reread after this long (its picture URL expires). */
const PROFILE_TTL_MS = 12 * 3_600_000;
/** A refused lookup (no permission, deleted user) is not retried on every message. */
const PROFILE_RETRY_MS = 3_600_000;
const MAX_DISPLAY_NAME = 100;

type StoredProfile = {
  checkedAt?: string;
  ok?: boolean;
  pictureUrl?: string;
};

const asRecord = (value: Prisma.JsonValue | null): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

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
    private readonly connectors: ChannelConnectorRegistry,
  ) {}

  /** The customer's row; created on first contact. Never trusts a payload company. */
  async contact(
    kind: StoredChannelKind,
    companyId: string,
    message: InboundMessage,
  ): Promise<InboundContact> {
    const row = await this.findOrCreate(kind, companyId, message);
    await this.refreshProfile(kind, message, row);
    return { contactId: row.id };
  }

  private async findOrCreate(
    kind: StoredChannelKind,
    companyId: string,
    message: InboundMessage,
  ) {
    const where = {
      companyId_channel_externalUserId: {
        companyId,
        channel: kind,
        externalUserId: message.externalUserId,
      },
    };
    const select = { id: true, displayName: true, metadata: true } as const;
    try {
      return await this.prisma.channelContact.upsert({
        where,
        // `accountId` is written by the server, used to address replies.
        create: {
          companyId,
          channel: kind,
          externalUserId: message.externalUserId,
          metadata: { accountId: message.accountId },
        },
        update: {},
        select,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.prisma.channelContact.findUniqueOrThrow({ where, select });
    }
  }

  /**
   * Keeps the customer's name and picture up to date from the platform. Runs
   * outside any transaction, never throws, and asks the platform at most once
   * per PROFILE_TTL_MS (PROFILE_RETRY_MS after a refusal).
   */
  private async refreshProfile(
    kind: StoredChannelKind,
    message: InboundMessage,
    row: {
      id: string;
      displayName: string | null;
      metadata: Prisma.JsonValue | null;
    },
  ): Promise<void> {
    const connector = this.connectors.find(kind);
    if (!connector?.fetchProfile) return;

    const metadata = asRecord(row.metadata);
    const previous = (metadata.profile ?? {}) as StoredProfile;
    const age = previous.checkedAt
      ? Date.now() - Date.parse(previous.checkedAt)
      : Number.NaN;
    if (age < (previous.ok ? PROFILE_TTL_MS : PROFILE_RETRY_MS)) return;

    try {
      const profile = await connector.fetchProfile({
        accountId: message.accountId,
        externalUserId: message.externalUserId,
      });
      const displayName = sanitizeText(profile?.displayName ?? '').slice(
        0,
        MAX_DISPLAY_NAME,
      );
      await this.prisma.channelContact.update({
        where: { id: row.id },
        data: {
          ...(displayName ? { displayName } : {}),
          metadata: {
            ...metadata,
            profile: {
              checkedAt: new Date().toISOString(),
              ok: Boolean(profile),
              // A refused lookup keeps the last picture; the dashboard falls back to initials if it expired.
              pictureUrl: profile?.pictureUrl ?? previous.pictureUrl,
            },
          },
        },
      });
    } catch {
      // A profile is a nicety; the next message tries again.
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
