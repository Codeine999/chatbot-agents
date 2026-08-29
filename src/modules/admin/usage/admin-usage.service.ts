import { Injectable } from '@nestjs/common';
import { UsageKind } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../company/company.service';

@Injectable()
export class AdminUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
  ) {}

  /**
   * The company has one shared wallet. Each admin's own allocation is the
   * ADMIN_AI_QUERY budget whose scope key is that admin's member id.
   */
  async getUsage(adminMemberId: string) {
    const companyId = await this.companyService.getCompanyId();
    const wallet = await this.prisma.creditWallet.findUnique({
      where: { companyId },
      select: { id: true, balanceCredit: true },
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
        balanceCredit: wallet?.balanceCredit ?? '0',
      },
      adminCredit: {
        admin: {
          walletId: adminBudget?.walletId ?? wallet?.id ?? '',
          limitCredit: adminBudget?.limitCredit ?? null,
          usedCredit: adminBudget?.usedCredit ?? '0',
        },
      },
    };
  }
}
