import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_MODEL } from '../../ai/ai.constants';
import { AiIntentAnalysis, ChatIntent } from './types/chat.types';

const VALID_INTENTS: ChatIntent[] = [
  'REGISTER', 'AI_CHAT', 'GENERAL_QUESTION', 'REGISTER_HOW_TO',
  'CONTACT_ADMIN', 'CHECK_STATUS', 'CHECK_PAYMENT_STATUS', 'UNKNOWN',
];

const FALLBACK: AiIntentAnalysis = {
  intent: 'UNKNOWN',
  confidence: 0,
  needsKnowledgeSearch: false,
  needsBusinessData: false,
  entities: {},
};

@Injectable()
export class AiIntentClassifierService {
  private readonly genAI: GoogleGenAI;
  private readonly logger = new Logger(AiIntentClassifierService.name);

  constructor() {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async analyze(input: string): Promise<AiIntentAnalysis> {
  const prompt = `Classify this customer message. Return JSON only, no markdown.

  Message: "${input.replace(/"/g, "'")}"

  Valid intents: ${VALID_INTENTS.join(', ')}

  Rules:
  - "สมัคร" alone = REGISTER high confidence
  - "สมัครยังไง"/"วิธีสมัคร"/"เปิดยูสยังไง" = REGISTER_HOW_TO + needsKnowledgeSearch:true
  - Casual chat, identity, greeting, or conversational messages such as "คุณคือใคร", "ทำอะไรอยู่", "ว่าไง", "เป็นไงบ้าง", "งง ai ปะ" = AI_CHAT + needsKnowledgeSearch:false + needsBusinessData:false
  - Payment/status questions = CHECK_PAYMENT_STATUS or CHECK_STATUS + needsBusinessData:true
  - General FAQ about the platform/service = GENERAL_QUESTION + needsKnowledgeSearch:true
  - Distinguish "I want to register" vs "How do I register?"
  - Do not answer the customer. Only classify intent.

  Return:
  {"intent":"...","confidence":0.0,"needsKnowledgeSearch":false,"needsBusinessData":false,"entities":{"name":"","phone":"","bankName":"","bankAccount":"","paymentRef":""}}`;

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
