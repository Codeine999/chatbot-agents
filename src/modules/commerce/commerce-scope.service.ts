import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAdmin } from '../../shared/guards/admin-auth.types';
import { scoped, type CommerceScope } from './types/commerce-scope';

@Injectable()
export class CommerceScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async forAdmin(admin: AuthenticatedAdmin): Promise<CommerceScope> {
    if (admin.companyId !== null) {
      const scope = scoped({ companyId: admin.companyId });
      if (
        !(await this.prisma.company.findUnique({
          where: { id: scope.companyId },
          select: { id: true },
        }))
      ) {
        throw new ForbiddenException('Company access is unavailable');
      }
      return scope;
    }

    // Legacy admins are allowed only a configured existing company or an unambiguous singleton.
    const configured = this.config.get<string>(
      'COMMERCE_LEGACY_ADMIN_COMPANY_ID',
    );
    if (configured) {
      const scope = scoped({ companyId: configured });
      if (
        !(await this.prisma.company.findUnique({
          where: { id: scope.companyId },
          select: { id: true },
        }))
      ) {
        throw new ForbiddenException('Legacy commerce company is unavailable');
      }
      return scope;
    }
    return this.forLineDeployment();
  }

  async forLineDeployment(): Promise<CommerceScope> {
    const companies = await this.prisma.company.findMany({
      select: { id: true },
      take: 2,
    });
    if (companies.length === 0)
      throw new ServiceUnavailableException(
        'Configure a company before using commerce',
      );
    if (companies.length !== 1)
      throw new ForbiddenException(
        'Commerce requires an unambiguous deployment company',
      );
    return scoped({ companyId: companies[0].id });
  }
}
