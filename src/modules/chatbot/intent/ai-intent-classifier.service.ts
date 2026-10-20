import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import { rethrowInsufficientCredit } from '../../usage/credit-point/insufficient-credit.exception';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersAiProviderService } from '../../ai/users-ai-provider.service';
import { AiBudgetService } from '../../usage/rate-limit/ai-budget.service';
import {
  AiRequestContext,
  LowConfidenceAnalysis,
} from '../shared/types/chat.types';
import { z } from 'zod';
import { toAiProviderMessages } from '../context/ai-provider-context';
import { stripJsonCodeFence } from '../../../utils/json.utils';
import { PrismaService } from '../../../prisma/prisma.service';
import { aiSettingTenantId } from '../../ai/ai-setting/ai-setting-config';
import {
  LOW_CONFIDENCE_CLASSIFIER_SYSTEM_INSTRUCTION,
  lowConfidenceClassifierPrompt,
} from '../shared/prompt/low-confidence-classifier.prompt';

const LOW_CONFIDENCE_FALLBACK: LowConfidenceAnalysis = {
  classification: 'BUSINESS',
  confidence: 0,
  failed: true,
};

/** Bounds the operator description so it stays a small classification hint. */
const BUSINESS_CONTEXT_MAX_CHARS = 1000;

@Injectable()
export class AiIntentClassifierService {
  private readonly logger = new Logger(AiIntentClassifierService.name);
  private readonly tenantId: string | null;

  constructor(
    private readonly aiBudgetService: AiBudgetService,
    private readonly usersAiProviderService: UsersAiProviderService,
    // Optional so callers without the active AiSetting classify as before.
    @Optional() private readonly prisma?: PrismaService,
    @Optional() config?: ConfigService,
  ) {
    this.tenantId = config ? aiSettingTenantId(config) : null;
  }

  async classifyLowConfidence(
    input: string,
    context: AiRequestContext = {},
  ): Promise<LowConfidenceAnalysis> {
    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      return LOW_CONFIDENCE_FALLBACK;
    }

    try {
      const businessContext = await this.loadBusinessContext();
      const response = await this.usersAiProviderService.generate(
        {
          systemInstruction: LOW_CONFIDENCE_CLASSIFIER_SYSTEM_INSTRUCTION,
          messages: toAiProviderMessages(
            context.recentMessages ?? [],
            lowConfidenceClassifierPrompt(input, businessContext),
          ),
          temperature: 0.1,
          maxOutputTokens: 300,
          reasoningEffort: 'low',
        },
        context,
      );
      const parsed: unknown = JSON.parse(
        stripJsonCodeFence(response.text.trim()),
      );

      return z
        .object({
          classification: z.enum(['BUSINESS', 'GENERAL']),
          confidence: z.number().min(0).max(1),
          reason: z.string().max(500).optional(),
        })
        .strict()
        .parse(parsed);
    } catch (error) {
      rethrowPendingAiUsage(error);
      rethrowInsufficientCredit(error);
      this.logger.warn(
        `low-confidence BUSINESS/GENERAL classification failed: ` +
          `${
            error instanceof z.ZodError
              ? error.issues
                  .map(
                    (issue) =>
                      `${issue.path.join('.') || 'root'}: ${issue.message}`,
                  )
                  .join('; ')
              : String(error)
          }`,
      );
      return LOW_CONFIDENCE_FALLBACK;
    }
  }

  /**
   * The active AiSetting's ownerPrompt tells the classifier what the business
   * sells, so "which herb helps back pain" is not mistaken for general advice.
   * A lookup failure only drops the hint; classification still runs.
   */
  private async loadBusinessContext(): Promise<string | undefined> {
    if (!this.prisma) return undefined;

    try {
      const setting = await this.prisma.aiSetting.findFirst({
        where: { active: true, tenantId: this.tenantId },
        orderBy: { updatedAt: 'desc' },
        select: { ownerPrompt: true },
      });

      return (
        setting?.ownerPrompt?.trim().slice(0, BUSINESS_CONTEXT_MAX_CHARS) ||
        undefined
      );
    } catch (error) {
      this.logger.warn(
        `business context for classification unavailable: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return undefined;
    }
  }
}
