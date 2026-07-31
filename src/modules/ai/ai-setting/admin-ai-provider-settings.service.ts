import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { PrismaService } from '../../../prisma/prisma.service';
import { allowedProvidersForAdminRole } from './admin-ai-provider.policy';
import { AiModelCatalogService } from './ai-model-catalog.service';
import {
  AdminAiProviderRuntimeSetting,
  AiProviderName,
} from '../../../ai-provider/types/ai-provider.types';

type UpdateAccessInput = Readonly<{
  enabled?: boolean;
  allowedProviders?: AiProviderName[];
}>;

@Injectable()
export class AdminAiProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogService: AiModelCatalogService,
  ) {}

  async get(adminMemberId: string): Promise<AdminAiProviderRuntimeSetting> {
    const adminMember = await this.prisma.adminMember.findUnique({
      where: { id: adminMemberId },
      select: { id: true, role: true },
    });

    if (!adminMember) {
      throw new NotFoundException('Admin member not found');
    }

    const roleAllowedProviders = allowedProvidersForAdminRole(adminMember.role);
    let setting = await this.prisma.adminAiProviderSetting.upsert({
      where: { adminMemberId },
      create: {
        adminMemberId,
        provider: 'GEMINI',
        model: this.catalogService.getDefaultModel('GEMINI'),
        allowedProviders: [...roleAllowedProviders],
      },
      update: {},
    });

    const allowedProviders = setting.allowedProviders.filter((provider) =>
      roleAllowedProviders.includes(provider),
    );

    if (!allowedProviders.length) {
      throw new ForbiddenException('No AI provider is allowed for this role');
    }

    if (!allowedProviders.includes(setting.provider)) {
      setting = await this.prisma.adminAiProviderSetting.update({
        where: { adminMemberId },
        data: {
          allowedProviders,
          provider: allowedProviders[0],
          model: this.catalogService.getDefaultModel(allowedProviders[0]),
        },
      });
    } else if (allowedProviders.length !== setting.allowedProviders.length) {
      setting = await this.prisma.adminAiProviderSetting.update({
        where: { adminMemberId },
        data: { allowedProviders },
      });
    }

    return this.toRuntimeSetting(setting);
  }

  async updateDefault(
    adminMemberId: string,
    provider: AiProviderName,
    model: string,
  ): Promise<AdminAiProviderRuntimeSetting> {
    const setting = await this.get(adminMemberId);

    if (!setting.allowedProviders.includes(provider)) {
      throw new ForbiddenException(
        `${provider} is not allowed for this admin account`,
      );
    }

    const normalizedModel = model.trim();
    this.catalogService.assertSelectable(provider, normalizedModel);

    const updated = await this.prisma.adminAiProviderSetting.update({
      where: { adminMemberId },
      data: { provider, model: normalizedModel },
    });

    return this.toRuntimeSetting(updated);
  }

  async updateAccess(
    actor: AuthenticatedAdmin,
    targetAdminMemberId: string,
    input: UpdateAccessInput,
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

    const current = await this.get(target.id);
    const allowedProviders = input.allowedProviders
      ? [...new Set(input.allowedProviders)]
      : [...current.allowedProviders];

    if (!allowedProviders.length) {
      throw new BadRequestException('At least one AI provider is required');
    }

    const roleAllowedProviders = allowedProvidersForAdminRole(target.role);
    const forbiddenProvider = allowedProviders.find(
      (provider) => !roleAllowedProviders.includes(provider),
    );

    if (forbiddenProvider) {
      throw new BadRequestException(
        `${forbiddenProvider} is not available for role=${target.role}`,
      );
    }

    const provider = allowedProviders.includes(current.provider)
      ? current.provider
      : allowedProviders[0];
    const model =
      provider === current.provider
        ? current.model
        : this.catalogService.getDefaultModel(provider);

    const updated = await this.prisma.adminAiProviderSetting.update({
      where: { adminMemberId: target.id },
      data: {
        enabled: input.enabled ?? current.enabled,
        allowedProviders,
        provider,
        model,
      },
    });

    return this.toRuntimeSetting(updated);
  }

  private toRuntimeSetting(setting: {
    adminMemberId: string;
    enabled: boolean;
    allowedProviders: AiProviderName[];
    provider: AiProviderName;
    model: string;
    updatedAt: Date;
  }): AdminAiProviderRuntimeSetting {
    return {
      adminMemberId: setting.adminMemberId,
      enabled: setting.enabled,
      allowedProviders: setting.allowedProviders,
      provider: setting.provider,
      model: setting.model,
      updatedAt: setting.updatedAt.toISOString(),
    };
  }
}
