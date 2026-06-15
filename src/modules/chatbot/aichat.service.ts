import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { AI_GENERATION_CONFIG, AI_MODEL } from '../../ai/ai.constants';
import { PrismaService } from '../../prisma/prisma.service';

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
  'ขออภัยครับ ตอนนี้ระบบยังไม่สามารถตอบคำถามนี้ได้ เดี๋ยวส่งต่อให้แอดมินช่วยตรวจสอบให้นะครับ';

@Injectable()
export class AiChatService {
  private readonly genAI: GoogleGenAI;

  constructor(private readonly prisma: PrismaService) {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  async answerCustomer(message: string): Promise<string> {
    let fallbackMessage = DEFAULT_FALLBACK_MESSAGE;

    try {
      const setting = await this.prisma.aiSetting.findFirst({
        where: { active: true },
        orderBy: { updatedAt: 'desc' },
        select: {
          systemPrompt: true,
          tone: true,
          fallbackMessage: true,
        },
      });

      const systemPrompt =
        setting?.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
      const tone = setting?.tone?.trim();
      fallbackMessage =
        setting?.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE;

      const prompt = [
        systemPrompt,
        tone ? `โทนการตอบ: ${tone}` : undefined,
        `ข้อความลูกค้า:\n${message}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await this.genAI.models.generateContent({
        model: AI_MODEL,
        contents: prompt,
        config: AI_GENERATION_CONFIG,
      });

      const reply = response.text;

      return reply?.trim() || fallbackMessage;
    } catch (error) {
      console.error('Gemini generateContent error:', error);

      return fallbackMessage;
    }
  }
}
