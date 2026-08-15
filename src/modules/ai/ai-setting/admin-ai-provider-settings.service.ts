import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { PrismaService } from '../../../prisma/prisma.service';
import { allowedProvidersForAdminRole } from './admin-ai-provider.policy';
import { AiModelCatalogService } from './ai-model-catalog.service';
import { AiProviderSettingsService } from '../ai-provider-settings.service';
import { AdminAiProviderRuntimeSetting } from '../../../ai-provider/types/ai-provider.types';

/**
 * All admins share one AI provider/model (AiProviderSettingsService, scope=ADMIN).
 * Role still caps which shared provider an account may actually use, and each
 * admin account can be switched on/off independently via `aiEnabled`.
 */
@Injectable()
export class AdminAiProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: AiModelCatalogService,
    private readonly aiProviderSettingsService: AiProviderSettingsService,
  ) {}

  async get(adminMemberId: string): Promise<AdminAiProviderRuntimeSetting> {
    const adminMember = await this.prisma.adminMember.findUnique({
      where: { id: adminMemberId },
      select: { id: true, role: true, aiEnabled: true },
    });

    if (!adminMember) {
      throw new NotFoundException('Admin member not found');
    }

    const allowedProviders = allowedProvidersForAdminRole(adminMember.role);
    const shared = await this.aiProviderSettingsService.get('ADMIN');

    const provider = allowedProviders.includes(shared.provider)
      ? shared.provider
      : allowedProviders[0];
    const model =
      provider === shared.provider
        ? shared.model
        : this.catalogService.getDefaultModel(provider);

    return {
      adminMemberId: adminMember.id,
      enabled: adminMember.aiEnabled,
      allowedProviders,
      provider,
      model,
      updatedAt: shared.updatedAt,
    };
  }

  async updateEnabled(
    actor: AuthenticatedAdmin,
    targetAdminMemberId: string,
    enabled: boolean,
  ): Promise<AdminAiProviderRuntimeSetting> {
    const target = await this.prisma.adminMember.findUnique({
      where: { id: targetAdminMemberId },
      select: { id: true, role: true },
    });

    if (!target) {
      throw new NotFoundException('Admin member not found');
    }

    if (actor.role === 'owner' && target.role !== 'admin') {
      throw new ForbiddenException(
        'Owners can manage AI access for admin accounts only',
      );
    }

    await this.prisma.adminMember.update({
      where: { id: target.id },
      data: { aiEnabled: enabled },
    });

    return this.get(target.id);
  }
}
