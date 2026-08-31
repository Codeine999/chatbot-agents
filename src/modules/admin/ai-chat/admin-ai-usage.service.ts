import { BadRequestException, Injectable } from '@nestjs/common';
import {
  LineChatSender,
  Prisma,
  UsageKind,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreditService } from '../../usage/credit-point/credit.service';

const ADMIN_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstname: true,
  lastname: true,
  role: true,
} as const;

type AdminSummaryRow = {
  id: string;
  username: string;
  firstname: string;
  lastname: string;
  role: string;
};

type UsageTotals = {
  messageCount: number;
  lastUsedAt: Date | null;
  chargedCredit: Prisma.Decimal;
};

type BudgetRow = {
  scopeKey: string;
  limitCredit: Prisma.Decimal | null;
  usedCredit: Prisma.Decimal;
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
  /** Credits this admin has burned in total. */
  chargedCreditTotal: string;
  /** Persistent budget for this admin; `limitCredit` null means unlimited. */
  usedCredit: string;
  limitCredit: string | null;
};

/**
 * Back-office AI usage reporting.
 *
 * There is no separate admin wallet: admin calls are debited from the single
 * company `CreditWallet` and attributed through `AiUsageEvent.adminMemberId`,
 * while each admin's allowance is a `CreditBudget` row scoped by
 * `scopeKey = adminMemberId`.
 */
@Injectable()
export class AdminAiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
  ) {}

  async getMyUsage(adminMemberId: string): Promise<AdminAiUsageSummary> {
    const [admin, totals, customerReplyCount, budgets] = await Promise.all([
      this.prisma.adminMember.findUniqueOrThrow({
        where: { id: adminMemberId },
        select: ADMIN_SUMMARY_SELECT,
      }),
      this.loadTotals(adminMemberId),
      this.prisma.lineChatHistory.count({
        where: { sender: LineChatSender.ADMIN, sentByAdminId: adminMemberId },
      }),
      this.creditService.listBudgets(UsageKind.ADMIN_AI_QUERY),
    ]);

    return this.toSummary(
      admin,
      totals.get(adminMemberId),
      customerReplyCount,
      budgets.find((budget) => budget.scopeKey === adminMemberId),
    );
  }

  /** Owner/dev view: usage for every admin account. */
  async listAllUsage(): Promise<AdminAiUsageSummary[]> {
    const [admins, totals, replyCounts, budgets] = await Promise.all([
      this.prisma.adminMember.findMany({
        select: ADMIN_SUMMARY_SELECT,
        orderBy: { username: 'asc' },
      }),
      this.loadTotals(),
      this.prisma.lineChatHistory.groupBy({
        by: ['sentByAdminId'],
        where: {
          sender: LineChatSender.ADMIN,
          sentByAdminId: { not: null },
        },
        _count: { _all: true },
      }),
      this.creditService.listBudgets(UsageKind.ADMIN_AI_QUERY),
    ]);

    const repliesByAdmin = new Map(
      replyCounts.map((row) => [row.sentByAdminId as string, row._count._all]),
    );
    const budgetsByAdmin = new Map(
      budgets.map((budget) => [budget.scopeKey, budget]),
    );

    return admins
      .map((admin) =>
        this.toSummary(
          admin,
          totals.get(admin.id),
          repliesByAdmin.get(admin.id) ?? 0,
          budgetsByAdmin.get(admin.id),
        ),
      )
      .sort((a, b) => b.messageCount - a.messageCount);
  }

  /** `null` is unlimited for owner/dev; normal admin accounts require a cap. */
  async setLimit(adminMemberId: string, limitCredit: string | null) {
    const admin = await this.prisma.adminMember.findUniqueOrThrow({
      where: { id: adminMemberId },
      select: { id: true, role: true },
    });

    if (admin.role === 'admin' && limitCredit === null) {
      throw new BadRequestException(
        'A finite AI credit budget is required for admin accounts',
      );
    }

    const budget = await this.creditService.setBudgetLimit(
      UsageKind.ADMIN_AI_QUERY,
      adminMemberId,
      limitCredit === null ? null : new Prisma.Decimal(limitCredit),
    );

    return {
      adminMemberId,
      usedCredit: budget.usedCredit.toString(),
      limitCredit: budget.limitCredit?.toString() ?? null,
    };
  }

  /** Successful admin AI calls grouped by admin, from the usage event log. */
  private async loadTotals(
    adminMemberId?: string,
  ): Promise<Map<string, UsageTotals>> {
    const rows = await this.prisma.aiUsageEvent.groupBy({
      by: ['adminMemberId'],
      where: {
        kind: UsageKind.ADMIN_AI_QUERY,
        status: 'success',
        adminMemberId: adminMemberId ? adminMemberId : { not: null },
      },
      _count: { _all: true },
      _max: { createdAt: true },
      _sum: { chargedCredit: true },
    });

    return new Map(
      rows
        .filter((row) => row.adminMemberId !== null)
        .map((row) => [
          row.adminMemberId as string,
          {
            messageCount: row._count._all,
            lastUsedAt: row._max.createdAt,
            chargedCredit: row._sum.chargedCredit ?? new Prisma.Decimal(0),
          },
        ]),
    );
  }

  private toSummary(
    admin: AdminSummaryRow,
    totals: UsageTotals | undefined,
    customerReplyCount: number,
    budget: BudgetRow | undefined,
  ): AdminAiUsageSummary {
    return {
      adminMemberId: admin.id,
      username: admin.username,
      firstname: admin.firstname,
      lastname: admin.lastname,
      role: admin.role,
      messageCount: totals?.messageCount ?? 0,
      lastUsedAt: totals?.lastUsedAt?.toISOString() ?? null,
      customerReplyCount,
      chargedCreditTotal: (
        totals?.chargedCredit ?? new Prisma.Decimal(0)
      ).toString(),
      usedCredit: (budget?.usedCredit ?? new Prisma.Decimal(0)).toString(),
      limitCredit: budget?.limitCredit?.toString() ?? null,
    };
  }
}
