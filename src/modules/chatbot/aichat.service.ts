import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_GENERATION_CONFIG, AI_MODEL } from '../../ai/ai.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';
import { KnowledgeItem } from './types/chat.types';

const DEFAULT_SYSTEM_PROMPT = `
คุณคือแอดมินตอบแชทลูกค้าผ่าน LINE OA
ตอบเป็นภาษาไทย สุภาพ กระชับ เป็นธรรมชาติ

กฎ:
- ถ้าไม่มีข้อมูลแน่ชัด ห้ามแต่งข้อมูลเอง
- ถ้าคำถามเกี่ยวกับสถานะชำระเงิน, สถานะจัดส่ง, ข้อมูลส่วนตัว ให้ตอบว่ายังไม่สามารถตรวจสอบได้และส่งต่อแอดมิน
- ห้ามบอกว่าคุณเป็น AI
- ไม่ต้องตอบยาวเกินไป
`.trim();

const DEFAULT_FALLBACK_MESSAGE =
  'ขออภัยครับ ตอนนี้ยังไม่สามารถตอบคำถามนี้ได้ เดี๋ยวส่งต่อให้แอดมินช่วยตรวจสอบให้นะครับ';

/** Grounded-answer rules — Gemini may only use the retrieved DB context. */
const KNOWLEDGE_RULES = `กฎเพิ่มเติม:
- ตอบจากข้อมูลที่ให้มาเท่านั้น ห้ามเพิ่มเติมจากความรู้ตัวเอง
- ห้ามยืนยันสถานะการสมัคร, การชำระเงิน, สถานะบัญชี, สถานะโอนเงิน หรือการกระทำของแอดมิน หากไม่มีในข้อมูลที่ให้มา
- ถ้าข้อมูลไม่เพียงพอ ให้บอกว่าไม่มีข้อมูลเพียงพอและแนะนำให้ติดต่อแอดมิน
- ตอบเป็นภาษาไทย สุภาพ กระชับ ชัดเจน`;

/** General-chat rules — small talk allowed, but never claim business status. */
const GENERAL_RULES = `กฎเพิ่มเติม:
- ตอบเป็นภาษาไทย สุภาพ กระชับ เป็นธรรมชาติ
- ตอบคำถามทั่วไปหรือ small talk ได้
- ห้ามแต่งข้อมูลธุรกิจ เช่น สถานะสมัคร สถานะบัญชี สถานะชำระเงิน หรือสถานะโอนเงิน
- ถ้าลูกค้าถามเรื่องสถานะสมัคร/ชำระเงิน/ข้อมูลส่วนตัว ให้บอกว่ายังตรวจสอบไม่ได้และแนะนำให้ติดต่อแอดมิน
- ห้ามบอกว่าคุณเป็น AI`;

type AiRuntimeSetting = {
  systemPrompt: string;
  tone?: string;
  fallbackMessage: string;
};

@Injectable()
export class AiChatService {
  private readonly genAI: GoogleGenAI;
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
  ) {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  /**
   * Knowledge-grounded answer. Use ONLY for ANSWER_KNOWLEDGE.
   * Answers strictly from retrieved DB context; falls back when nothing matches.
   */
  async answerKnowLedge(message: string): Promise<string> {
    const { systemPrompt, tone, fallbackMessage } = await this.getActiveAiSetting();

    let items: KnowledgeItem[];
    try {
      items = await this.knowledgeRetrievalService.retrieve(message);
    } catch (error) {
      this.logger.error('knowledge retrieval failed', error as Error);
      return fallbackMessage;
    }

    // No knowledge found -> do not let Gemini invent an answer.
    if (items.length === 0) return fallbackMessage;

    // Single high-score answer pattern -> return the stored answer directly.
    const direct = this.tryGetDirectAnswer(items, tone);
    if (direct) return direct;

    const prompt = this.buildKnowledgePrompt({ systemPrompt, tone, items, message });
    return this.generateText(prompt, fallbackMessage);
  }

  /**
   * General / small-talk answer. Use for casual chat.
   * Never touches the knowledge base and never claims business status.
   */
  async answerGeneral(message: string): Promise<string> {
    const { systemPrompt, tone, fallbackMessage } = await this.getActiveAiSetting();
    const prompt = this.buildGeneralPrompt({ systemPrompt, tone, message });
    return this.generateText(prompt, fallbackMessage);
  }

  // --- private helpers ------------------------------------------------------

  /** Load the active AiSetting, resolving to safe defaults on miss/error. */
  private async getActiveAiSetting(): Promise<AiRuntimeSetting> {
    try {
      const setting = await this.prisma.aiSetting.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
        select: { systemPrompt: true, tone: true, fallbackMessage: true },
      });

      return {
        systemPrompt: setting?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
        tone: setting?.tone?.trim() || undefined,
        fallbackMessage: setting?.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE,
      };
    } catch (error) {
      this.logger.error('failed to load AiSetting, using defaults', error as Error);
      return { systemPrompt: DEFAULT_SYSTEM_PROMPT, fallbackMessage: DEFAULT_FALLBACK_MESSAGE };
    }
  }

  /** Call Gemini and return trimmed text, or the fallback on empty/error. */
  private async generateText(prompt: string, fallbackMessage: string): Promise<string> {
    try {
      const response = await this.genAI.models.generateContent({
        model: AI_MODEL,
        contents: prompt,
        config: AI_GENERATION_CONFIG,
      });
      return response.text?.trim() || fallbackMessage;
    } catch (error) {
      this.logger.error('Gemini generateContent failed', error as Error);
      return fallbackMessage;
    }
  }

  /**
   * Return a stored answer verbatim when exactly one strong answer pattern
   * matched and no custom tone is configured (saves a Gemini call).
   * When a tone is set we defer to Gemini so the tone is actually applied.
   */
  private tryGetDirectAnswer(items: KnowledgeItem[], tone?: string): string | null {
    if (tone) return null;

    const [first] = items;
    if (
      items.length === 1 &&
      first.source === 'ANSWER_PATTERN' &&
      first.score >= 3 &&
      first.answer
    ) {
      return first.answer.trim();
    }
    return null;
  }

  /** Build a grounded prompt that forces Gemini to answer only from DB context. */
  private buildKnowledgePrompt(params: {
    systemPrompt: string;
    tone?: string;
    items: KnowledgeItem[];
    message: string;
  }): string {
    const { systemPrompt, tone, items, message } = params;

    const contextBlock = items
      .map((item) =>
        [
          `หัวข้อ: ${item.title ?? ''}`,
          item.category ? `หมวดหมู่: ${item.category}` : null,
          item.content ? `รายละเอียด: ${item.content}` : null,
          item.answer ? `คำตอบ: ${item.answer}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n---\n\n');

    return [
      systemPrompt,
      tone ? `โทนการตอบ: ${tone}` : null,
      `ข้อมูลจากฐานข้อมูล (ตอบโดยใช้ข้อมูลนี้เท่านั้น):\n${contextBlock}`,
      KNOWLEDGE_RULES,
      `ข้อความลูกค้า:\n${message}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Build a general-chat prompt: small talk allowed, business status forbidden. */
  private buildGeneralPrompt(params: {
    systemPrompt: string;
    tone?: string;
    message: string;
  }): string {
    const { systemPrompt, tone, message } = params;

    return [
      systemPrompt,
      tone ? `โทนการตอบ: ${tone}` : null,
      GENERAL_RULES,
      `ข้อความลูกค้า:\n${message}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
