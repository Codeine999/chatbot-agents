import { Injectable } from '@nestjs/common';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderService } from './ai-provider.service';
import {
  LINE_AI_BUDGET_SCOPE_KEY,
  LineAiUsageContext,
} from '../usage/billing/ai-usage.types';
import {
  AiGenerateRequest,
  AiGenerateResponse,
} from '../../ai-provider/types/ai-provider.types';
import { AiBillingService } from '../usage/billing/ai-billing.service';

/**
 * Injectable entry point for user-facing AI modules, and the single billing
 * choke point for customer-facing traffic: every LINE reply, intent
 * classification and query-planning call is metered here as
 * `UsageKind.LINE_AI_REPLY` against the shared `*` budget scope.
 */
@Injectable()
export class UsersAiProviderService {
  constructor(
    private readonly settingsService: AiProviderSettingsService,
    private readonly aiProviderService: AiProviderService,
    private readonly billingService: AiBillingService,
  ) {}

  async generate(
    request: AiGenerateRequest,
    context: LineAiUsageContext = {},
  ): Promise<AiGenerateResponse> {
    const { provider, model } = await this.settingsService.get('USER');

    return this.billingService.runBilled({
      kind: 'LINE_AI_REPLY',
      scopeKey: LINE_AI_BUDGET_SCOPE_KEY,
      provider,
      model,
      request,
      lineMemberId: context.lineMemberId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      call: () => this.aiProviderService.generateWith(provider, model, request),
    });
  }
}
