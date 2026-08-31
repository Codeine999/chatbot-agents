import { ForbiddenException, Injectable } from '@nestjs/common';
import { AdminAiProviderSettingsService } from './ai-setting/admin-ai-provider-settings.service';
import { AiModelCatalogService } from './ai-setting/ai-model-catalog.service';
import { AiProviderService } from './ai-provider.service';
import {
  AiGenerateRequest,
  AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';
import { AiBillingService } from '../usage/billing/ai-billing.service';

@Injectable()
export class AdminAiProviderService {
  constructor(
    private readonly aiProviderService: AiProviderService,
    private readonly settingsService: AdminAiProviderSettingsService,
    private readonly catalogService: AiModelCatalogService,
    private readonly billingService: AiBillingService,
  ) {}

  async generate(
    adminMemberId: string,
    request: AiGenerateRequest,
    context: { idempotencyKey?: string } = {},
  ): Promise<AiGenerateResponse> {
    const setting = await this.settingsService.get(adminMemberId);

    if (!setting.enabled) {
      throw new ForbiddenException('AI is disabled for this admin account');
    }

    const { provider, model } = setting;

    this.catalogService.assertSelectable(provider, model);

    return this.billingService.runBilled({
      kind: 'ADMIN_AI_QUERY',
      scopeKey: adminMemberId,
      adminMemberId,
      requireBudgetLimit: setting.role === 'admin',
      idempotencyKey: context.idempotencyKey,
      provider,
      model,
      request,
      call: () => this.aiProviderService.generateWith(provider, model, request),
    });
  }
}
