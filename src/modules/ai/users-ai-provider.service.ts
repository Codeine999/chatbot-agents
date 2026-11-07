import { Injectable, Optional } from '@nestjs/common';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiProviderService } from './ai-provider.service';
import {
  LINE_AI_BUDGET_SCOPE_KEY,
  LineAiUsageContext,
} from '../usage/billing/ai-usage.types';
import {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProviderName,
} from '../../ai-provider/types/ai-provider.types';
import { AiBillingService } from '../usage/billing/ai-billing.service';
import { DecisionTraceService } from '../decision-log/decision-trace.service';

@Injectable()
export class UsersAiProviderService {
  constructor(
    private readonly settingsService: AiProviderSettingsService,
    private readonly aiProviderService: AiProviderService,
    private readonly billingService: AiBillingService,
    @Optional() private readonly decisionTrace?: DecisionTraceService,
  ) {}

  async selection(): Promise<{ provider: AiProviderName; model: string }> {
    const { provider, model } = await this.settingsService.get('USER');
    return { provider, model };
  }

  async generate(
    request: AiGenerateRequest,
    context: LineAiUsageContext = {},
    pinned?: {
      provider: AiProviderName;
      model: string;
      operationKey: string;
      beforeCall?: () => Promise<void>;
    },
  ): Promise<AiGenerateResponse> {
    const { provider, model } =
      pinned ?? (await this.settingsService.get('USER'));
    const started = Date.now();

    const response = this.billingService.runBilled({
      kind: 'LINE_AI_REPLY',
      scopeKey: LINE_AI_BUDGET_SCOPE_KEY,
      provider,
      model,
      request,
      lineMemberId: context.lineMemberId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      idempotencyKey: pinned?.operationKey,
      call: async () => {
        await pinned?.beforeCall?.();
        return this.aiProviderService.generateWith(provider, model, request);
      },
    });
    if (!this.decisionTrace) return response;
    try {
      const result = await response;
      this.decisionTrace.llmCall({
        provider,
        model,
        latencyMs: Date.now() - started,
        status: 'success',
        ...result.usage,
      });
      return result;
    } catch (error) {
      this.decisionTrace.llmCall({
        provider,
        model,
        latencyMs: Date.now() - started,
        status: 'failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  }
}
