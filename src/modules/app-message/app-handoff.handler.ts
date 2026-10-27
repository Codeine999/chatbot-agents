import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../admin/notification/notification.service';
import { ChannelHandoffRegistry } from '../users/session/channel-handoff.registry';
import type { ChannelHandoffHandler } from '../users/session/channel-handoff.registry';
import { UserSessionService } from '../users/session/user-session.service';
import { appUserId } from './app-session.service';

const USER_ID_PREFIX = appUserId('');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AppHandoffHandler implements ChannelHandoffHandler, OnModuleInit {
  readonly userIdPrefix = USER_ID_PREFIX;
  private readonly logger = new Logger(AppHandoffHandler.name);

  constructor(
    private readonly registry: ChannelHandoffRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly sessions: UserSessionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async requestAdmin(userId: string): Promise<void> {
    const contactId = userId.slice(USER_ID_PREFIX.length);
    if (!UUID.test(contactId)) return;

    const changed = await this.prisma.channelConversation.updateMany({
      where: { contactId, status: { not: 'waiting_admin' } },
      data: { status: 'waiting_admin' },
    });
    if (!changed.count) return;

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
      if (!conversation) return;
      await this.notifications.notifyChannelAdminRequired({
        userId,
        channel: 'APP',
        conversationId: conversation.id,
        displayName: conversation.contact.displayName,
        lastMessage: conversation.lastMessage,
        flow: workflow?.flow ?? 'CONTACT_ADMIN',
        step: workflow?.step ?? 'WAITING_ADMIN',
        status: workflow?.status ?? 'ACTIVE',
      });
    } catch (error) {
      // The room is already marked; a failed notification must not fail the turn.
      this.logger.warn(
        `failed to notify admins for ${contactId}: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }
}
