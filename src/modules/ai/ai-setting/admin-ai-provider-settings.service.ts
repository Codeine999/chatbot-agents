import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiProviderSettingsService } from '../ai-provider-settings.service';
import { AdminAiProviderRuntimeSetting } from '../../../ai-provider/types/ai-provider.types';

@Injectable()
export class AdminAiProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
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

    const shared = await this.aiProviderSettingsService.get('ADMIN');

    return {
      adminMemberId: adminMember.id,
      role: adminMember.role,
      enabled: adminMember.aiEnabled,
      provider: shared.provider,
      model: shared.model,
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
