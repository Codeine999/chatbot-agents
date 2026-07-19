import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_MODEL } from '../../ai/ai.constants';
import { AiBudgetService } from '../../infra/rate-limit/ai-budget.service';
import {
  AiIntentAnalysis,
  AiRequestContext,
  ChatIntent,
} from './types/chat.types';
import {
  AI_CLASSIFIER_FALLBACK,
  CLASSIFIER_SYSTEM_INSTRUCTION,
  VALID_INTENTS,
} from './constants/ai-intent.constants';
import { toGeminiContents } from './context/gemini-context';
import { classifierPrompt } from './constants/classifier.prompt';
import { stripJsonCodeFence } from '../../utils/json.utils';

@Injectable()
export class AiIntentClassifierService {
  private readonly genAI: GoogleGenAI;
  private readonly logger = new Logger(AiIntentClassifierService.name);

  constructor(private readonly aiBudgetService: AiBudgetService) {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async analyze(
    input: string,
    context: AiRequestContext = {},
  ): Promise<AiIntentAnalysis> {
    // Over-budget requests skip Gemini; the UNKNOWN fallback routes to the
    // exact configured fallback instead of another AI answer call.
    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      return { ...AI_CLASSIFIER_FALLBACK, standaloneQuery: input };
    }

    const prompt = classifierPrompt(input, VALID_INTENTS);
    try {
      const res = await this.genAI.models.generateContent({
        model: AI_MODEL,
        contents: toGeminiContents(context.recentMessages ?? [], prompt),
        config: {
          systemInstruction: CLASSIFIER_SYSTEM_INSTRUCTION,
          httpOptions: {
            timeout: 8_000,
          },
          temperature: 0,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: {
              intent: {
                type: 'string',
                enum: VALID_INTENTS,
              },
              confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
              },
              standaloneQuery: {
                type: 'string',
              },
            },
            required: ['intent', 'confidence', 'standaloneQuery'],
            additionalProperties: false,
          },
        },
      });

      const rawResponseText = res.text?.trim() ?? '';
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
}
