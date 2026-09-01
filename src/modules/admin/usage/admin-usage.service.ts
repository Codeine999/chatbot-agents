import { Injectable } from '@nestjs/common';
import { Prisma, UsageKind } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  AdminRole,
  AuthenticatedAdmin,
} from '../../../shared/guards/admin-auth.types';
import { LineAdminService } from '../../line/admin/line-admin.service';
import { CompanyService } from '../company/company.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AdminCreditBudget = {
  adminMemberId: string;
  username: string;
  firstname: string;
  lastname: string;
  role: AdminRole;
  walletId: string;
  limitCredit: Prisma.Decimal | null;
  usedCredit: Prisma.Decimal | number;
  reservedCredit: Prisma.Decimal | number;
};

@Injectable()
export class AdminUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
    private readonly lineAdminService: LineAdminService,
  ) {}

  /**
   * Push-message allowance from the LINE plan itself (not credits).
   * `null` is returned for plans LINE reports as `type: 'none'` — no cap.
   */
  async getLinePushMessageQuota(): Promise<number | null> {
    const quota = await this.lineAdminService.getMessageQuota();

    return quota.type === 'limited' ? (quota.value ?? null) : null;
  }

  /**
   * The company has one shared wallet. Each admin's own allocation is the
   * ADMIN_AI_QUERY budget whose scope key is that admin's member id.
   */
  async getUsage(adminMemberId: string) {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { companyId },
      select: { id: true, balanceCredit: true, lifetimeSpentCredit: true },
    });
    const adminBudget = wallet
      ? await this.prisma.creditBudget.findUnique({
          where: {
            walletId_kind_scopeKey: {
              walletId: wallet.id,
              kind: UsageKind.ADMIN_AI_QUERY,
              scopeKey: adminMemberId,
            },
          },
          select: {
            walletId: true,
            limitCredit: true,
            usedCredit: true,
          },
        })
      : null;

    return {
      companyCredit: {
        balanceCredit: wallet?.balanceCredit ?? 0,
        usedCredit: wallet?.lifetimeSpentCredit ?? 0,
      },
      adminCredit: {
        admin: {
          walletId: adminBudget?.walletId ?? wallet?.id ?? '',
          limitCredit: adminBudget?.limitCredit ?? null,
          usedCredit: adminBudget?.usedCredit ?? 0,
        },
      },
    };
  }

  /**
   * Budget list keyed by admin account. `dev` and `owner` see every admin that
   * owns an ADMIN_AI_QUERY budget; a plain `admin` only ever sees their own.
   */
  async getUsageAllAdmin(actor: AuthenticatedAdmin) {
    const seesEveryAdmin = actor.role === 'dev' || actor.role === 'owner';
    const budgets = await this.prisma.creditBudget.findMany({
      where: {
        kind: UsageKind.ADMIN_AI_QUERY,
        ...(seesEveryAdmin ? {} : { scopeKey: actor.id }),
      },
      select: {
        walletId: true,
        scopeKey: true,
        limitCredit: true,
        usedCredit: true,
        reservedCredit: true,
      },
    });

    // scopeKey is free-form text — only rows scoped to an admin id can be joined.
    const adminIds = budgets
      .map((budget) => budget.scopeKey)
      .filter((scopeKey) => UUID_PATTERN.test(scopeKey));

    const admins = adminIds.length
      ? await this.prisma.adminMember.findMany({
          where: { id: { in: adminIds } },
          select: {
            id: true,
            username: true,
            firstname: true,
            lastname: true,
            role: true,
          },
          orderBy: { username: 'asc' },
        })
      : [];

    const budgetByAdminId = new Map(
      budgets.map((budget) => [budget.scopeKey, budget]),
    );

    const rows: AdminCreditBudget[] = admins.flatMap((admin) => {
      const budget = budgetByAdminId.get(admin.id);
      if (!budget) return [];

      return [
        {
          adminMemberId: admin.id,
          username: admin.username,
          firstname: admin.firstname,
          lastname: admin.lastname,
          role: admin.role,
          walletId: budget.walletId,
          limitCredit: budget.limitCredit ?? null,
          usedCredit: budget.usedCredit ?? 0,
          reservedCredit: budget.reservedCredit ?? 0,
        },
      ];
    });

    // The caller's own account always leads the list; the rest stay username-sorted.
    rows.sort((a, b) => {
      if (a.adminMemberId === actor.id) return -1;
      if (b.adminMemberId === actor.id) return 1;
      return 0;
    });

    return { admins: rows };
  }
}
