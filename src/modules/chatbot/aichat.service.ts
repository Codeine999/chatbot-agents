import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { AI_GENERATION_CONFIG, AI_MODEL } from '../../ai/ai.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
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

/**
 * Direct-answer gate: the top answer_patterns match must score at least this
 * (an exact question-example or full-message keyword hit reaches it)...
 */
const DIRECT_ANSWER_MIN_SCORE = 5;
/** ...and be at least this far ahead of the runner-up to skip Gemini. */
const DIRECT_ANSWER_MIN_GAP = 2;

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
    private readonly answerPatternService: AnswerPatternService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {
    this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  /**
   * Knowledge-grounded answer. Use ONLY for ANSWER_KNOWLEDGE.
   *
   * Flow (in priority order):
   * 1. Direct DB search on answer_patterns (no embedding).
   * 2. One clearly strong pattern -> return its stored answer verbatim (no LLM).
   * 3. Several related patterns -> Gemini composes strictly from them.
   * 4. No useful pattern -> embedding-based retrieval as fallback.
   * 5. Nothing anywhere (or unrecoverable error) -> fallbackMessage.
   */
  async answerKnowLedge(message: string): Promise<string> {
    const setting = await this.getActiveAiSetting();

    // 1) Direct DB search — errors here must not kill the flow.
    let matches: KnowledgeItem[] = [];
    try {
      matches = await this.answerPatternService.findMatches(message);
    } catch (error) {
      this.logger.error(
        'answer_patterns direct search failed, falling back to embedding',
        error as Error,
      );
    }

    if (matches.length > 0) {
      // 2) One clearly strong match -> stored answer, no Gemini call.
      const direct = this.tryGetDirectAnswer(matches);
      if (direct) return direct;

      // 3) Multiple related matches -> Gemini, grounded on those items only.
      return this.generateFromKnowledge(matches, message, setting);
    }

    // 4) Nothing useful from answer_patterns -> embedding retrieval.
    return this.answerFromEmbedding(message, setting);
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
   * Return a stored answer verbatim when the top answer pattern is strong
   * AND clearly ahead of the runner-up. Saves a Gemini call and guarantees
   * the admin-authored answer is delivered unchanged.
   */
  private tryGetDirectAnswer(items: KnowledgeItem[]): string | null {
    const [top, second] = items;

    if (
      top?.source === 'ANSWER_PATTERN' &&
      top.answer &&
      top.score >= DIRECT_ANSWER_MIN_SCORE &&
      (!second || top.score - second.score >= DIRECT_ANSWER_MIN_GAP)
    ) {
      return top.answer.trim();
    }
    return null;
  }

  /** Gemini answer grounded strictly on the given knowledge items. */
  private async generateFromKnowledge(
    items: KnowledgeItem[],
    message: string,
    setting: AiRuntimeSetting,
  ): Promise<string> {
    const prompt = this.buildKnowledgePrompt({
      systemPrompt: setting.systemPrompt,
      tone: setting.tone,
      fallbackMessage: setting.fallbackMessage,
      items,
      message,
    });
    return this.generateText(prompt, setting.fallbackMessage);
  }

  /**
   * Embedding-based fallback, used only when the direct answer_patterns
   * search found nothing useful. Any failure resolves to fallbackMessage.
   */
  private async answerFromEmbedding(
    message: string,
    setting: AiRuntimeSetting,
  ): Promise<string> {
    let items: KnowledgeItem[] = [];
    try {
      items = await this.semanticSearchService.search(message);
    } catch (error) {
      this.logger.error('embedding retrieval failed', error as Error);
      return setting.fallbackMessage;
    }

    // No semantic knowledge either -> never let Gemini invent an answer.
    if (items.length === 0) return setting.fallbackMessage;

    return this.generateFromKnowledge(items, message, setting);
  }

  /** Build a grounded prompt that forces Gemini to answer only from DB context. */
  private buildKnowledgePrompt(params: {
    systemPrompt: string;
    tone?: string;
    fallbackMessage: string;
    items: KnowledgeItem[];
    message: string;
  }): string {
    const { systemPrompt, tone, fallbackMessage, items, message } = params;

    const contextBlock = items
      .map((item, index) =>
        [
          `[ข้อมูลที่ ${index + 1}]`,
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
      `ถ้าข้อมูลข้างต้นไม่เพียงพอที่จะตอบคำถามลูกค้า ให้ตอบด้วยข้อความนี้เท่านั้น:\n"${fallbackMessage}"`,
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
