import { KNOWLEDGE_RULES } from '../../../ai/prompt/ai-chat.constants';
import { INSUFFICIENT_CONTEXT } from '../../../../shared/knowledge/knowledge-routing.constants';
import type { KnowledgeItem } from '../../../../shared/contracts/chat.types';
import type { AiRuntimeSetting } from '../../../ai/prompt/ai-runtime.types';
import { composeAiAnswerPrompt } from '../../../ai/prompt/ai-setting-prompt.composer';

/** Build immutable grounded instructions from the retrieved DB context. */
export function buildKnowledgeSystemInstruction(params: {
  setting: AiRuntimeSetting;
  items: KnowledgeItem[];
  allowGeneralExit: boolean;
}): string {
  return composeAiAnswerPrompt({
    setting: params.setting,
    ragContext: params.items,
    modeRules: [
      KNOWLEDGE_RULES,
      `AnswerPattern เป็นคำตอบที่ผ่านการดูแล; MicroKnowledge เป็นข้อเท็จจริงที่นำมาประกอบกันได้ เรียบเรียงคำตอบให้เข้ากับคำถามของลูกค้าได้
          ไม่จำเป็นต้องคัดลอกทั้งประโยค แต่ห้ามเพิ่มหรือเปลี่ยนข้อเท็จจริง และต้องคงเงื่อนไขหรือข้อจำกัดที่หลักฐานระบุไว้ 
          ตอบประเด็นหลักก่อนและเว้นบรรทัดระหว่างประเด็นอย่างเป็นธรรมชาติ`,

      `หลักฐานต้องระบุสิ่งที่ลูกค้าถามโดยตรง (มี ไม่มี ราคา เวลา หรือเงื่อนไขของสิ่งนั้น) จึงตอบได้ และเสริมทางเลือกที่หลักฐานระบุไว้ได้ 
          ถ้าหลักฐานกล่าวถึงเพียงสิ่งอื่นที่ใกล้เคียงหรือใช้แทนกันได้ ให้ใช้ INSUFFICIENT_CONTEXT 
          ห้ามตอบด้วยสิ่งทดแทน เช่น ถามว่าในห้องมีเครื่องชงกาแฟไหม แต่หลักฐานมีแค่กาต้มน้ำ`,

      `คืน JSON เท่านั้น ตามรูปแบบใดรูปแบบหนึ่ง:
          ตอบได้: {"askedAbout":"สิ่งที่ลูกค้าถาม","directlyAnswered":true,"decision":"ANSWER","answer":"คำตอบภาษาไทย","evidenceIds":["SOURCE:ID"],"unanswered":[]}
          หลักฐานไม่พอ: {"askedAbout":"สิ่งที่ลูกค้าถาม","directlyAnswered":false,"decision":"${INSUFFICIENT_CONTEXT}","answer":"","evidenceIds":[],"unanswered":[]}${
            params.allowGeneralExit
              ? `
          ไม่ใช่เรื่องของร้าน: {"askedAbout":"สิ่งที่ลูกค้าถาม","directlyAnswered":false,"decision":"NOT_BUSINESS","answer":"","evidenceIds":[],"unanswered":[]}`
              : ''
          }`,

      `askedAbout คือสิ่งที่ลูกค้าถามถึงจริง ๆ สั้น ๆ; directlyAnswered เป็น true
          เฉพาะเมื่อหลักฐานระบุ askedAbout เองโดยตรง ไม่ใช่สิ่งทดแทนหรือบริการอื่นที่ใกล้เคียง
          ถ้าข้อความมีหลายคำถาม directlyAnswered เป็น true เมื่อหลักฐานตอบได้โดยตรงอย่างน้อยหนึ่งคำถาม`,

      `ใช้ ANSWER เฉพาะเมื่อ directlyAnswered เป็น true และข้อมูลที่อ้างใน evidenceIds รองรับคำตอบทุกข้อ
         ให้คัดลอกค่า ref จากรายการใน ragContext ลง evidenceIds ตรงตัว (รวม source และเครื่องหมาย :)
         ห้ามสร้าง ID เอง หากข้อมูลขาดหรือขัดแย้งให้ใช้ INSUFFICIENT_CONTEXT`,

      `ถ้าข้อความมีหลายคำถามและหลักฐานตอบได้เพียงบางคำถาม ให้ใช้ ANSWER ตอบเฉพาะคำถามที่หลักฐานระบุโดยตรง
         แล้วใส่คำถามที่ตอบไม่ได้ลงใน unanswered (ข้อความสั้น ๆ คำถามละหนึ่งรายการ ไม่เกิน 3 รายการ)
         ห้ามเดา ห้ามตอบแทนด้วยสิ่งใกล้เคียง และไม่ต้องเขียนใน answer ว่าส่วนนั้นไม่มีข้อมูล
         ระบบจะแจ้งลูกค้าเองว่าเจ้าหน้าที่จะตรวจสอบส่วนที่เหลือ ถ้าตอบได้ครบทุกคำถามให้ unanswered เป็น []`,

      ...(params.allowGeneralExit
        ? [
            `ใช้ NOT_BUSINESS เฉพาะเมื่อข้อความล่าสุดของลูกค้าเป็นการทักทาย ขอบคุณ คุยเล่น ถามเกี่ยวกับตัวผู้ช่วยเอง
         หรือความรู้ทั่วไปที่ไม่ต้องใช้ข้อมูลของร้านเลย ถ้าเกี่ยวกับสินค้า บริการ ราคา การสั่งซื้อ การชำระเงิน การจัดส่ง
         นโยบาย หรือข้อมูลของร้านแม้เพียงบางส่วน หรือไม่แน่ใจ ให้ใช้ INSUFFICIENT_CONTEXT ห้ามใช้ NOT_BUSINESS`,
          ]
        : []),
    ].join('\n\n'),
  });
}
