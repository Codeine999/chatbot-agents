import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_MODEL } from '../../ai/ai.constants';
import { AiIntentAnalysis, ChatIntent } from './types/chat.types';
import { classifierPrompt } from './constant/AnalyzePrompt';

const VALID_INTENTS: ChatIntent[] = [
  'REGISTER', 'GENERAL_QUESTION', 'REGISTER_HOW_TO',
  'CONTACT_ADMIN', 'UNKNOWN',
];

const FALLBACK: AiIntentAnalysis = {
  intent: 'UNKNOWN',
  confidence: 0,
};

@Injectable()
export class AiIntentClassifierService {
  private readonly genAI: GoogleGenAI;
  private readonly logger = new Logger(AiIntentClassifierService.name);

  constructor() {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async analyze(input: string): Promise<AiIntentAnalysis> {
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
