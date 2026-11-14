import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHANNEL_KINDS,
  STORED_CHANNEL_KINDS,
  type StoredChannelKind,
} from '../../shared/channel/channel-kinds';
import { NotificationService } from '../admin/notification/notification.service';
import { ChannelHandoffRegistry } from '../users/session/channel-handoff.registry';
import type { AdminRequestResult } from '../users/session/channel-handoff.registry';
import { UserSessionService } from '../users/session/user-session.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "The customer asked for an admin" for every channel stored in channel*
 * tables. One registry entry per channel prefix (`app:`, `fb:`, ...).
 */
@Injectable()
export class ChannelStoreHandoff implements OnModuleInit {
  private readonly logger = new Logger(ChannelStoreHandoff.name);

  constructor(
    private readonly registry: ChannelHandoffRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly sessions: UserSessionService,
  ) {}

  onModuleInit(): void {
    for (const kind of STORED_CHANNEL_KINDS) {
      const userIdPrefix = CHANNEL_KINDS[kind].userIdPrefix;
      this.registry.register({
        userIdPrefix,
        requestAdmin: (userId) =>
          this.requestAdmin(kind, userId.slice(userIdPrefix.length), userId),
      });
    }
  }

  /**
   * Marks the room `waiting_admin`; admins are notified only on the transition.
   * ALREADY_WAITING lets the chatbot skip a repeat fallback notice.
   */
  async requestAdmin(
    channel: StoredChannelKind,
    contactId: string,
    userId: string,
  ): Promise<AdminRequestResult> {
    if (!UUID.test(contactId)) return 'NO_ROOM';

    const changed = await this.prisma.channelConversation.updateMany({
      where: { contactId, channel, status: { not: 'waiting_admin' } },
      data: { status: 'waiting_admin' },
    });
    if (!changed.count) {
      const waiting = await this.prisma.channelConversation.count({
        where: { contactId, channel, status: 'waiting_admin' },
      });
      return waiting > 0 ? 'ALREADY_WAITING' : 'NO_ROOM';
    }

    try {
      const [conversation, workflow] = await Promise.all([
        this.prisma.channelConversation.findUnique({
          where: { contactId },
          select: {
            id: true,
            lastMessage: true,
            contact: { select: { displayName: true } },
          },
        }),
        this.sessions.get(userId),
      ]);
      // The room is already marked; without a row only the notice is skipped.
      if (conversation) {
        await this.notifications.notifyChannelAdminRequired({
          userId,
          channel,
          conversationId: conversation.id,
          displayName: conversation.contact.displayName,
          lastMessage: conversation.lastMessage,
          flow: workflow?.flow ?? 'CONTACT_ADMIN',
          step: workflow?.step ?? 'WAITING_ADMIN',
          status: workflow?.status ?? 'ACTIVE',
        });
      }
    } catch (error) {
      // The room is already marked; a failed notification must not fail the turn.
      this.logger.warn(
        `failed to notify admins for ${contactId}: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    return 'REQUESTED';
  }
}
