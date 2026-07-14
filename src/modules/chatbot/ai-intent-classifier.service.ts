import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_MODEL } from '../../ai/ai.constants';
import { AiBudgetService } from '../../infra/rate-limit/ai-budget.service';
import { AiIntentAnalysis, ChatIntent } from './types/chat.types';
import { classifierPrompt } from './constant/AnalyzePrompt';

const VALID_INTENTS: ChatIntent[] = [
  'REGISTER', 'GENERAL_QUESTION', 'REGISTER_HOW_TO',
  'CONTACT_ADMIN', 'ANSWER_KNOWLEDGE', 'UNKNOWN',
];

const FALLBACK: AiIntentAnalysis = {
  intent: 'UNKNOWN',
  confidence: 0,
};

@Injectable()
export class AiIntentClassifierService {
  private readonly genAI: GoogleGenAI;
  private readonly logger = new Logger(AiIntentClassifierService.name);

  constructor(private readonly aiBudgetService: AiBudgetService) {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async analyze(input: string, userId?: string): Promise<AiIntentAnalysis> {
    // Over-budget requests skip Gemini; the UNKNOWN fallback routes to a
    // safe general answer instead of an AI classification.
    if (!(await this.aiBudgetService.tryConsume(userId))) {
      return FALLBACK;
    }

    const prompt = classifierPrompt(input, VALID_INTENTS);
    try {
      const res = await this.genAI.models.generateContent({
        model: AI_MODEL,
        contents: prompt,
        config: { maxOutputTokens: 200 },
      });

      const text = res.text?.trim() ?? '';
      const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(jsonText) as AiIntentAnalysis;

      if (!VALID_INTENTS.includes(parsed.intent)) parsed.intent = 'UNKNOWN';
      parsed.confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));

      return parsed;
    } catch (err) {
      this.logger.warn(`AI intent classification failed: ${String(err)}`);
      return FALLBACK;
    }
  }
}
