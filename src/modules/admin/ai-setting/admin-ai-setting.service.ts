import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiSetting, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedAdmin } from '../../../shared/guards/admin-auth.types';
import { aiSettingTenantId } from '../../ai/ai-setting/ai-setting-config';
import {
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_SYSTEM_PROMPT,
} from '../../chatbot/constants/ai-chat.constants';
import {
  CreateAdminAiSettingDto,
  UpdateAdminAiSettingDto,
} from './dto/admin-ai-setting.dto';

export type AdminAiSettingResponse =
  | AiSetting
  | Omit<AiSetting, 'systemPrompt'>;

@Injectable()
export class AdminAiSettingService {
  private readonly tenantId: string | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.tenantId = aiSettingTenantId(config);
  }

  async list(admin: AuthenticatedAdmin): Promise<AdminAiSettingResponse[]> {
    const settings = await this.prisma.aiSetting.findMany({
      where: { tenantId: this.tenantId },
      orderBy: { updatedAt: 'desc' },
    });

    return settings.map((setting) => this.toResponse(setting, admin));
  }

  async create(
    input: CreateAdminAiSettingDto,
    admin: AuthenticatedAdmin,
  ): Promise<AdminAiSettingResponse> {
    this.assertCanWriteSystemPrompt(input.systemPrompt, admin);
    this.assertTenant(input.tenantId);

    const setting = await this.prisma.aiSetting.create({
      data: {
        tenantId: this.tenantId,
        systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        ownerPrompt: input.ownerPrompt ?? null,
        tone: input.tone ?? null,
        skills: input.skills,
        responseStyle: input.responseStyle,
        promptVersion: input.promptVersion,
        fallbackMessage: input.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE,
        active: input.active,
      },
    });

    return this.toResponse(setting, admin);
  }

  async update(
    id: string,
    input: UpdateAdminAiSettingDto,
    admin: AuthenticatedAdmin,
  ): Promise<AdminAiSettingResponse> {
    this.assertCanWriteSystemPrompt(input.systemPrompt, admin);
    this.assertTenant(input.tenantId);

    const existing = await this.prisma.aiSetting.findFirst({
      where: { id, tenantId: this.tenantId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('AI setting not found');
    }

    const data: Prisma.AiSettingUpdateInput = {};
    if (input.systemPrompt !== undefined) {
      data.systemPrompt = input.systemPrompt;
    }
    if (input.ownerPrompt !== undefined) {
      data.ownerPrompt = input.ownerPrompt;
    }
    if (input.tone !== undefined) data.tone = input.tone;
    if (input.skills !== undefined) {
      data.skills = input.skills;
    }
    if (input.responseStyle !== undefined) {
      data.responseStyle = input.responseStyle;
    }
    if (input.promptVersion !== undefined) {
      data.promptVersion = input.promptVersion;
    }
    if (input.fallbackMessage !== undefined) {
      data.fallbackMessage = input.fallbackMessage;
    }
    if (input.active !== undefined) data.active = input.active;

    const setting = await this.prisma.aiSetting.update({
      where: { id },
      data,
    });

    return this.toResponse(setting, admin);
  }

  async remove(
    id: string,
    admin: AuthenticatedAdmin,
  ): Promise<{ deleted: true }> {
    // Keep the actor mandatory so direct service use cannot bypass auth.
    void admin;
    const result = await this.prisma.aiSetting.deleteMany({
      where: { id, tenantId: this.tenantId },
    });

    if (!result.count) {
      throw new NotFoundException('AI setting not found');
    }

    return { deleted: true };
  }

  private assertCanWriteSystemPrompt(
    systemPrompt: string | undefined,
    admin: AuthenticatedAdmin,
  ): void {
    if (systemPrompt !== undefined && admin.role !== 'dev') {
      throw new ForbiddenException('Only DEV may modify systemPrompt');
    }
  }

  private assertTenant(requestedTenantId: string | null | undefined): void {
    if (
      requestedTenantId !== undefined &&
      requestedTenantId !== this.tenantId
    ) {
      throw new ForbiddenException(
        'AI setting tenantId must match the configured deployment tenant',
      );
    }
  }

  private toResponse(
    setting: AiSetting,
    admin: AuthenticatedAdmin,
  ): AdminAiSettingResponse {
    if (admin.role === 'dev') return setting;

    const { systemPrompt: _systemPrompt, ...publicSetting } = setting;
    void _systemPrompt;
    return publicSetting;
  }
}
