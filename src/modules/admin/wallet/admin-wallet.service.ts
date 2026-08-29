import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CompanyService } from '../company/company.service';

@Injectable()
export class AdminWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companyService: CompanyService,
  ) {}


  async getMine() {
    const companyId = await this.companyService.getCompanyId();
    const existing = await this.prisma.creditWallet.findUnique({
      where: { companyId },
    });

    if (existing) return existing;

    return this.prisma.creditWallet.upsert({
      where: { companyId },
      create: { companyId },
      update: {},
    });
  }
}
