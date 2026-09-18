import { rethrowPendingAiUsage } from '../usage/billing/pending-ai-usage.error';
import { Injectable, Logger } from '@nestjs/common';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { AiRequestContext, LowConfidenceAnalysis } from './types/chat.types';
import { z } from 'zod';
import { toAiProviderMessages } from './context/ai-provider-context';
import { stripJsonCodeFence } from '../../utils/json.utils';
import {
  LOW_CONFIDENCE_CLASSIFIER_SYSTEM_INSTRUCTION,
  lowConfidenceClassifierPrompt,
} from './constants/low-confidence-classifier.prompt';

const LOW_CONFIDENCE_FALLBACK: LowConfidenceAnalysis = {
  classification: 'BUSINESS',
  confidence: 0,
};

@Injectable()
export class AiIntentClassifierService {
  private readonly logger = new Logger(AiIntentClassifierService.name);

  constructor(
    private readonly aiBudgetService: AiBudgetService,
    private readonly usersAiProviderService: UsersAiProviderService,
  ) {}

  async classifyLowConfidence(
    input: string,
    context: AiRequestContext = {},
  ): Promise<LowConfidenceAnalysis> {
    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      return LOW_CONFIDENCE_FALLBACK;
    }

    try {
      const response = await this.usersAiProviderService.generate(
        {
          systemInstruction: LOW_CONFIDENCE_CLASSIFIER_SYSTEM_INSTRUCTION,
          messages: toAiProviderMessages(
            context.recentMessages ?? [],
            lowConfidenceClassifierPrompt(input),
          ),
          temperature: 0,
          maxOutputTokens: 300,
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
}
