import { Injectable, Logger } from '@nestjs/common';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import {
  AiIntentAnalysis,
  AiRequestContext,
  ChatIntent,
  LowConfidenceAnalysis,
} from './types/chat.types';
import {
  AI_CLASSIFIER_FALLBACK,
  CLASSIFIER_SYSTEM_INSTRUCTION,
  VALID_INTENTS,
} from './constants/ai-intent.constants';
import { toAiProviderMessages } from './context/ai-provider-context';
import { classifierPrompt } from './constants/classifier.prompt';
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

  async analyze(
    input: string,
    context: AiRequestContext = {},
  ): Promise<AiIntentAnalysis> {
    // Over-budget requests skip AI; the UNKNOWN fallback routes to the
    // exact configured fallback instead of another AI answer call.
    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      return { ...AI_CLASSIFIER_FALLBACK, standaloneQuery: input };
    }

    const prompt = classifierPrompt(input, VALID_INTENTS);
    try {
      const response = await this.usersAiProviderService.generate(
        {
          systemInstruction: CLASSIFIER_SYSTEM_INSTRUCTION,
          messages: toAiProviderMessages(context.recentMessages ?? [], prompt),
          temperature: 0,
          maxOutputTokens: 300,
        },
        context,
      );

      const rawResponseText = response.text.trim();
      const jsonText = stripJsonCodeFence(rawResponseText);
      const parsed: unknown = JSON.parse(jsonText);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('intent response is not an object');
      }

      const candidate = parsed as Partial<AiIntentAnalysis>;
      const intent = VALID_INTENTS.includes(candidate.intent as ChatIntent)
        ? (candidate.intent as ChatIntent)
        : 'UNKNOWN';
      const confidence = Math.min(
        1,
        Math.max(0, Number(candidate.confidence) || 0),
      );
      const standaloneQuery =
        typeof candidate.standaloneQuery === 'string' &&
        candidate.standaloneQuery.trim()
          ? candidate.standaloneQuery.trim().slice(0, 2_000)
          : input;

      return { intent, confidence, standaloneQuery };
    } catch (err) {
      this.logger.warn(`AI intent classification failed: ${String(err)}`);
      return { ...AI_CLASSIFIER_FALLBACK, standaloneQuery: input };
    }
  }

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

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('low-confidence response is not an object');
      }

      const candidate = parsed as Record<string, unknown>;
      const classification = candidate.classification;
      if (classification !== 'BUSINESS' && classification !== 'GENERAL') {
        throw new Error('invalid low-confidence classification');
      }

      const confidence = Math.min(
        1,
        Math.max(0, Number(candidate.confidence) || 0),
      );
      const generatedResponse =
        typeof candidate.response === 'string'
          ? candidate.response.trim().slice(0, 4_000)
          : '';

      return {
        classification,
        confidence,
        response:
          classification === 'GENERAL' && generatedResponse
            ? generatedResponse
            : undefined,
      };
    } catch (error) {
      this.logger.warn(
        `low-confidence BUSINESS/GENERAL classification failed: ${String(error)}`,
      );
      return LOW_CONFIDENCE_FALLBACK;
    }
  }
}
