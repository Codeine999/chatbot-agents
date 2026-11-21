import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AppMessageConfig } from './app-message.config';

const INTERVAL_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/**
 * Enforces APP_HISTORY_RETENTION_DAYS for guest chats. Every statement is an
 * idempotent delete, so two instances running at once is harmless. Touches
 * App Message data, the product turns of those rooms and the admin alerts
 * those guests caused, nothing else: LINE tables and usage/billing records
 * keep their history.
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

  private async purgeProductTurns(cutoff: Date): Promise<number> {
    const old: Prisma.CommerceTurnWhereInput = {
      createdAt: { lt: cutoff },
      channelConversation: { is: { channel: 'APP' } },
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.commerceLlmCall.deleteMany({ where: { turn: old } });
      return (await tx.commerceTurn.deleteMany({ where: old })).count;
    });
  }

  /**
   * Back-office preview turns hold the admin's redacted test messages and have
   * no room to age out with; a preview session lives 30 minutes, so a day is
   * ample. The calls go first (RESTRICT).
   */
  private async purgePreviewTurns(now: Date): Promise<number> {
    const old: Prisma.CommerceTurnWhereInput = {
      previewSessionKey: { not: null },
      createdAt: { lt: new Date(now.getTime() - DAY_MS) },
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.commerceLlmCall.deleteMany({ where: { turn: old } });
      return (await tx.commerceTurn.deleteMany({ where: old })).count;
    });
  }

  async purge(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - this.config.values.historyRetentionDays * DAY_MS,
    );
    try {
      const report = {
        // Product turns keep a redacted copy of the guest's message and recent
        // history, so they age out with the messages. Their calls go first
        // (RESTRICT), and a room is only removed once none of its turns is left.
        productTurns:
          (await this.purgeProductTurns(cutoff)) +
          (await this.purgePreviewTurns(now)),
        // Quiet rooms go with their messages; a room holding a turn is kept.
        conversations: (
          await this.prisma.channelConversation.deleteMany({
            where: {
              channel: 'APP',
              lastMessageAt: { lt: cutoff },
              OR: [{ activeUntil: null }, { activeUntil: { lt: now } }],
              commerceTurns: { none: {} },
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
