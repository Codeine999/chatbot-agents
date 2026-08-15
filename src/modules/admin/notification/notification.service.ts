import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ConversationSession } from '../../chatbot/types/session.types';
import type { AdminNotification } from '../../../generated/prisma/client';
import { NotificationGateway } from './notification.gateway';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationGateway: NotificationGateway,
  ) {}

  /** Persists an admin notification for the session, then broadcasts it live. */
  async notifyAdminRequired(
    session: Pick<ConversationSession, 'userId' | 'flow' | 'step' | 'status'>,
  ): Promise<void> {
    this.logger.debug(
      `notify admin: userId=${session.userId} flow=${session.flow} step=${session.step}`,
    );

    const notification = await this.prisma.adminNotification.create({
      data: {
        type: session.flow,
        title: 'Customer needs admin attention',
        message: `User ${session.userId} is waiting at step "${session.step}"`,
        userId: session.userId,
        metadata: {
          flow: session.flow,
          step: session.step,
          status: session.status,
        },
      },
    });

    this.notificationGateway.emitAdminNotification(notification);
  }

  async list(unreadOnly = false, limit = 50): Promise<AdminNotification[]> {
    return this.prisma.adminNotification.findMany({
      where: unreadOnly ? { isRead: false } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getUnreadCount(): Promise<number> {
    return this.prisma.adminNotification.count({ where: { isRead: false } });
  }

  async markAsRead(id: string): Promise<AdminNotification> {
    return this.prisma.adminNotification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllAsRead(): Promise<void> {
    await this.prisma.adminNotification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
  }
}
