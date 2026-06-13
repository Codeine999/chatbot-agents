import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { AI_GENERATION_CONFIG, AI_MODEL } from '../../ai/ai.constants';

@Injectable()
export class AiChatService {
  private readonly genAI: GoogleGenAI;

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  async answerCustomer(message: string): Promise<string> {
    const prompt = `
        คุณคือแอดมินตอบแชทลูกค้าผ่าน LINE OA
        ตอบเป็นภาษาไทย สุภาพ กระชับ เป็นธรรมชาติ

        กฎ:
        - ถ้าไม่มีข้อมูลแน่ชัด ห้ามแต่งข้อมูลเอง
        - ถ้าคำถามเกี่ยวกับสถานะชำระเงิน, สถานะจัดส่ง, ข้อมูลส่วนตัว ให้ตอบว่ายังไม่สามารถตรวจสอบได้และส่งต่อแอดมิน
        - ห้ามบอกว่าคุณเป็น AI
        - ไม่ต้องตอบยาวเกินไป

        ข้อความลูกค้า: ${message}`;

    try {
      const response = await this.genAI.models.generateContent({
        model: AI_MODEL,
        contents: prompt,
        config: AI_GENERATION_CONFIG,
      });

      const reply = response.text;

      return (
        reply?.trim() ||
        'ขออภัยครับ ตอนนี้ระบบยังไม่สามารถตอบคำถามนี้ได้ เดี๋ยวส่งต่อให้แอดมินช่วยตรวจสอบให้นะครับ'
      );
    } catch (error) {
      console.error('Gemini generateContent error:', error);

      return 'ขออภัยครับ ตอนนี้ระบบตอบกลับอัตโนมัติขัดข้องชั่วคราว เดี๋ยวส่งต่อให้แอดมินช่วยตรวจสอบให้นะครับ';
    }
  }
}
