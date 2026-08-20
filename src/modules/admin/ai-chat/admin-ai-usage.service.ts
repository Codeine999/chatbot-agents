import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CreditWalletType,
  LineChatSender,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

const ADMIN_AI_QUERY_COST = 1;

const ADMIN_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstname: true,
  lastname: true,
  role: true,
  aiUsage: { select: { messageCount: true, lastUsedAt: true } },
} as const;

type AdminSummaryRow = {
  id: string;
  username: string;
  firstname: string;
  lastname: string;
  role: string;
  aiUsage: { messageCount: number; lastUsedAt: Date | null } | null;
};

export type AdminAiUsageSummary = {
  adminMemberId: string;
  username: string;
  firstname: string;
  lastname: string;
  role: string;
  messageCount: number;
  lastUsedAt: string | null;
  /** LINE customer replies pushed by this admin (counted from LineChatHistory). */
  customerReplyCount: number;
};

/**
 * Back-office AI usage accounting.
 *
 * Two separate concerns:
 * - per-admin attribution lives in `AdminAiUsage` (who used how much)
 * - the org-wide pool is `CreditWallet[ADMIN_AI_QUERY]`, kept apart from the
 *   customer-facing LINE_MESSAGE / AI_USAGE wallets
 *
 * The wallet gate is opt-in: when no ADMIN_AI_QUERY wallet row exists the
 * feature is treated as unmetered, so admin chat works before billing is set
 * up instead of failing closed on an unconfigured install.
 */
@Injectable()
export class AdminAiUsageService {
  private readonly logger = new Logger(AdminAiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Charges the shared admin-AI pool when one is configured.
   * Throws 402 only when a wallet exists and is out of credit.
   */
  async reserveAdminAiCredit(): Promise<void> {
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { type: CreditWalletType.ADMIN_AI_QUERY },
      select: { id: true, active: true },
    });

    if (!wallet) {
      this.logger.debug(
        'No ADMIN_AI_QUERY wallet configured — admin AI usage is unmetered',
      );
      return;
    }

    if (!wallet.active) return;

    const result = await this.prisma.creditWallet.updateMany({
      where: {
        type: CreditWalletType.ADMIN_AI_QUERY,
        active: true,
        balance: { gte: ADMIN_AI_QUERY_COST },
      },
      data: {
        balance: { decrement: ADMIN_AI_QUERY_COST },
        usedTotal: { increment: ADMIN_AI_QUERY_COST },
      },
    });

    if (result.count === 0) {
      throw new HttpException(
        'Insufficient admin AI credit',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async refundAdminAiCredit(): Promise<void> {
    await this.prisma.creditWallet.updateMany({
      where: { type: CreditWalletType.ADMIN_AI_QUERY, active: true },
      data: {
        balance: { increment: ADMIN_AI_QUERY_COST },
        usedTotal: { decrement: ADMIN_AI_QUERY_COST },
      },
    });
  }

  async recordUsage(adminMemberId: string): Promise<void> {
    await this.prisma.adminAiUsage.upsert({
      where: { adminMemberId },
      create: { adminMemberId, messageCount: 1, lastUsedAt: new Date() },
      update: {
        messageCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  async getMyUsage(adminMemberId: string): Promise<AdminAiUsageSummary> {
    const [admin, customerReplyCount] = await Promise.all([
      this.prisma.adminMember.findUniqueOrThrow({
        where: { id: adminMemberId },
        select: ADMIN_SUMMARY_SELECT,
      }),
      this.prisma.lineChatHistory.count({
        where: { sender: LineChatSender.ADMIN, sentByAdminId: adminMemberId },
      }),
    ]);

    return this.toSummary(admin, customerReplyCount);
  }

  /** Owner/dev view: usage for every admin account. */
  async listAllUsage(): Promise<AdminAiUsageSummary[]> {
    const [admins, replyCounts] = await Promise.all([
      this.prisma.adminMember.findMany({
        select: ADMIN_SUMMARY_SELECT,
        orderBy: { username: 'asc' },
      }),
      this.prisma.lineChatHistory.groupBy({
        by: ['sentByAdminId'],
        where: {
          sender: LineChatSender.ADMIN,
          sentByAdminId: { not: null },
        },
        _count: { _all: true },
      }),
    ]);

    const repliesByAdmin = new Map(
      replyCounts.map((row) => [row.sentByAdminId as string, row._count._all]),
    );

    return admins
      .map((admin) =>
        this.toSummary(admin, repliesByAdmin.get(admin.id) ?? 0),
      )
      .sort((a, b) => b.messageCount - a.messageCount);
  }

  private toSummary(
    admin: AdminSummaryRow,
    customerReplyCount: number,
  ): AdminAiUsageSummary {
    return {
      adminMemberId: admin.id,
      username: admin.username,
      firstname: admin.firstname,
      lastname: admin.lastname,
      role: admin.role,
      messageCount: admin.aiUsage?.messageCount ?? 0,
      lastUsedAt: admin.aiUsage?.lastUsedAt?.toISOString() ?? null,
      customerReplyCount,
    };
  }
}
