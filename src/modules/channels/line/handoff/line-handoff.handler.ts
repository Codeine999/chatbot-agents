import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CHANNEL_KINDS } from '../../../../shared/channel/channel-kinds';
import { NotificationService } from '../../../admin/notification/notification.service';
import { ChannelHandoffRegistry } from '../../../session/channel-handoff.registry';
import type {
  AdminRequestResult,
  ChannelHandoffHandler,
} from '../../../session/channel-handoff.registry';
import { UserSessionService } from '../../../session/user-session.service';

/**
 * "The customer asked for an admin" for LINE rooms (`lineConversation`).
 * LINE user ids carry no channel prefix, so this is the handler the registry
 * falls back to when no prefixed channel (`app:`, `fb:`) claims the user.
 */
@Injectable()
export class LineHandoffHandler implements ChannelHandoffHandler, OnModuleInit {
  readonly userIdPrefix = CHANNEL_KINDS.LINE.userIdPrefix;
  // Same log context as before this code moved out of UserSessionService.
  private readonly logger = new Logger(UserSessionService.name);

  constructor(
    private readonly registry: ChannelHandoffRegistry,
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly sessions: UserSessionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Marks the room `waiting_admin`; admins are notified only on the transition. */
  async requestAdmin(userId: string): Promise<AdminRequestResult> {
    const changed = await this.prisma.lineConversation.updateMany({
      where: {
        lineMember: { lineUserId: userId },
        status: { not: 'waiting_admin' },
      },
      data: { status: 'waiting_admin' },
    });
    if (changed.count === 0) {
      const waiting = await this.prisma.lineConversation.count({
        where: { lineMember: { lineUserId: userId }, status: 'waiting_admin' },
      });
      return waiting > 0 ? 'ALREADY_WAITING' : 'NO_ROOM';
    }

    try {
      const workflow = await this.sessions.get(userId);
      await this.notificationService.notifyAdminRequired({
        userId,
        flow: workflow?.flow ?? 'CONTACT_ADMIN',
        step: workflow?.step ?? 'WAITING_ADMIN',
        status: workflow?.status ?? 'ACTIVE',
      });
    } catch (error) {
      this.logger.warn(
        `failed to notify admins for user=${userId}: ${String(error)}`,
      );
    }
    return 'REQUESTED';
  }
}
