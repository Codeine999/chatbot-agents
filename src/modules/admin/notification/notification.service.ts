import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ConversationSession } from '../../chatbot/types/session.types';
import { NotificationGateway } from './notification.gateway';
import {
  toAdminNotification,
  type AdminNotification,
  type NotificationMetadata,
} from './types/notification.type';

export type {
  AdminNotification,
  NotificationMetadata,
} from './types/notification.type';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationGateway: NotificationGateway,
  ) {}


  async notifyAdminRequired(
    session: Pick<ConversationSession, 'userId' | 'flow' | 'step' | 'status'>,
  ): Promise<void> {
    this.logger.debug(
      `notify admin: userId=${session.userId} flow=${session.flow} step=${session.step}`,
    );

    const conversation = await this.prisma.lineConversation.findFirst({
      where: { lineMember: { lineUserId: session.userId } },
      select: {
        id: true,
        lastMessage: true,
        lineMember: { select: { displayName: true, pictureUrl: true } },
      },
    });

    if (!conversation) {
      this.logger.warn(
        `no LINE conversation for userId=${session.userId} — notification will not be clickable`,
      );
    }

    const metadata: NotificationMetadata = {
      conversationId: conversation?.id ?? null,
      displayName: conversation?.lineMember.displayName ?? null,
      pictureUrl: conversation?.lineMember.pictureUrl ?? null,
      lastMessage: conversation?.lastMessage ?? null,
      flow: session.flow,
      step: session.step,
      status: session.status,
    };

    const row = await this.prisma.adminNotification.create({
      data: {
        type: session.flow,
        title: 'Customer needs admin attention',
        message: `User ${session.userId} is waiting at step "${session.step}"`,
        userId: session.userId,
        metadata,
      },
    });

    this.notificationGateway.emitAdminNotification(toAdminNotification(row));
  }

  async list(unreadOnly = false, limit = 50): Promise<AdminNotification[]> {
    const rows = await this.prisma.adminNotification.findMany({
      where: unreadOnly ? { isRead: false } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return rows.map(toAdminNotification);
  }

  async getUnreadCount(): Promise<number> {
    return this.prisma.adminNotification.count({ where: { isRead: false } });
  }

  async markAsRead(id: string): Promise<AdminNotification> {
    const row = await this.prisma.adminNotification.update({
      where: { id },
      data: { isRead: true },
    });

    return toAdminNotification(row);
  }

  async markAllAsRead(): Promise<void> {
    await this.prisma.adminNotification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Clears the unread notifications tied to a conversation, e.g. when an admin
   * opens it. Filters on the JSON path because `conversationId` lives in
   * `metadata`; the `isRead` index still narrows the scan.
   */
  async markConversationAsRead(conversationId: string): Promise<void> {
    await this.prisma.adminNotification.updateMany({
      where: {
        isRead: false,
        metadata: { path: ['conversationId'], equals: conversationId },
      },
      data: { isRead: true },
    });
  }
}
