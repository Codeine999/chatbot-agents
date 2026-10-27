import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppMessageConfig } from './app-message.config';

const INTERVAL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Enforces APP_HISTORY_RETENTION_DAYS for guest chats. Every statement is an
 * idempotent delete, so two instances running at once is harmless. Touches
 * App Message data and the admin alerts those guests caused, nothing else:
 * LINE tables and usage/billing records keep their history.
 */
@Injectable()
export class AppMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppMessageConfig,
  ) {}

  onModuleInit(): void {
    // Runs even with the feature off, so retention still holds after it is disabled.
    this.timer = setInterval(() => void this.purge(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - this.config.values.historyRetentionDays * DAY_MS,
    );
    try {
      const report = {
        // Quiet rooms go with their messages; a room holding a turn is kept.
        conversations: (
          await this.prisma.channelConversation.deleteMany({
            where: {
              channel: 'APP',
              lastMessageAt: { lt: cutoff },
              OR: [{ activeUntil: null }, { activeUntil: { lt: now } }],
            },
          })
        ).count,
        // Old messages of rooms that are still active.
        messages: (
          await this.prisma.channelMessage.deleteMany({
            where: {
              createdAt: { lt: cutoff },
              conversation: { channel: 'APP' },
            },
          })
        ).count,
        // These alerts carry the guest's last message.
        notifications: (
          await this.prisma.adminNotification.deleteMany({
            where: {
              userId: { startsWith: 'app:' },
              createdAt: { lt: cutoff },
            },
          })
        ).count,
        sessions: (
          await this.prisma.appGuestSession.deleteMany({
            where: {
              OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
            },
          })
        ).count,
        // Guests left with no session and no room. A contact linked to a
        // customer is never removed.
        contacts: (
          await this.prisma.channelContact.deleteMany({
            where: {
              channel: 'APP',
              customerId: null,
              createdAt: { lt: new Date(now.getTime() - DAY_MS) },
              sessions: { none: {} },
              conversation: { is: null },
            },
          })
        ).count,
      };
      if (Object.values(report).some((count) => count > 0))
        this.logger.log(`app retention purge ${JSON.stringify(report)}`);
      return report;
    } catch (error) {
      this.logger.error(
        `app retention purge failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return null;
    }
  }
}
