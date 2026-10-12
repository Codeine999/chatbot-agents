/**
 * LLM-as-judge for the live product audit. A second model (a different family
 * from the chat model by default, to avoid self-preference) reads one whole
 * conversation with the store's ground truth and scores every bot reply plus
 * the conversation as a whole. Advisory: deterministic checks decide pass/fail.
 */
import { z } from 'zod';
import type {
  AiGenerateRequest,
  AiGenerateResponse,
} from '../../src/ai-provider/types/ai-provider.types';

export type JudgeTurn = {
  index: number;
  customer: string;
  bot: string;
  /** Internal routing outcome and plan, so the judge can tell a bad route from bad wording. */
  route: string;
  /** What the case author expects the system to decide, and why. */
  expected?: string;
};

export type JudgeInput = {
  caseId: string;
  title: string;
  storeFacts: string;
  turns: JudgeTurn[];
};

const score = z.number().int().min(1).max(5);
export const judgeSchema = z.object({
  turns: z.array(
    z.object({
      index: z.number().int(),
      correctness: score,
      grounding: score,
      helpfulness: score,
      naturalness: score,
      tone: score,
      hallucinations: z.array(z.string()).default([]),
      issues: z.array(z.string()).default([]),
    }),
  ),
  conversation: z.object({
    coherence: score,
    contextMemory: score,
    consistency: score,
    progress: score,
    handoff: score,
  }),
  verdict: z.enum(['GOOD', 'ACCEPTABLE', 'POOR', 'UNSAFE']),
  summary: z.string(),
  suggestions: z.array(z.string()).default([]),
});
export type JudgeVerdict = z.infer<typeof judgeSchema>;
export type JudgeResult = {
  verdict?: JudgeVerdict;
  error?: string;
  ms: number;
  model?: string;
};

export const JUDGE_SYSTEM = `คุณคือผู้ตรวจคุณภาพแชทบอทบริการลูกค้าของร้านเสื้อผ้าออนไลน์บน LINE (ภาษาไทย)
ประเมินคำตอบของบอททุกข้อความ และบทสนทนาโดยรวม อย่างเข้มงวด เป็นกลาง และอ้างอิงหลักฐาน

แหล่งความจริงมีอย่างเดียวคือ "ข้อมูลร้าน" ที่ให้มา ห้ามใช้ความรู้ภายนอกตัดสินข้อเท็จจริงของร้าน
(ราคา สต็อก ตัวเลือกสินค้า นโยบาย การมีหรือไม่มีสินค้า) ความรู้ทั่วไปที่ไม่ใช่ข้อเท็จจริงของร้าน เช่น
คุณสมบัติทั่วไปของผ้า พูดได้ถ้าไม่ผิดและไม่อ้างว่าเป็นข้อมูลร้าน

คะแนนรายข้อความ (1-5):
- correctness: ตอบตรงสิ่งที่ลูกค้าถามและถูกต้องตามข้อมูลร้าน (5 ถูกครบ / 3 ถูกบางส่วนหรือตกประเด็นสำคัญ / 1 ผิด)
- grounding: ทุกข้อเท็จจริงของร้านมีอยู่ในข้อมูลร้านจริง (5 ไม่มีการแต่ง / 1 แต่งข้อมูลสำคัญ)
  การบอกว่ายังไม่มีข้อมูลหรือส่งต่อแอดมินถือว่า grounded
- helpfulness: ช่วยให้ลูกค้าไปต่อได้ เช่น บอกตัวเลือกที่มี ถามกลับเมื่อคำถามกำกวม เสนอทางเลือกเมื่อของหมด
- naturalness: ภาษาไทยเป็นธรรมชาติแบบแอดมินร้านคุยแชท ไม่แข็งเหมือนแบบฟอร์ม ไม่มีศัพท์ระบบหรือข้อความแปลก
  ไม่ยาวเกินจำเป็นสำหรับแชท (5 เหมือนคนจริง / 1 อ่านเหมือนเครื่องหรือสับสน)
- tone: สุภาพ เป็นกันเอง ใช้ "ค่ะ" สม่ำเสมอตามบุคลิกร้าน

คะแนนทั้งบทสนทนา (1-5):
- coherence: ลื่นไหล ต่อเนื่อง ไม่ตอบหลุดเรื่อง
- contextMemory: จำสินค้าและสิ่งที่ลูกค้าบอกไว้ก่อนหน้าได้ถูก ไม่ถามซ้ำโดยไม่จำเป็น ไม่สลับสินค้า
- consistency: ข้อมูลไม่ขัดกันเองข้ามข้อความ
- progress: พาลูกค้าเข้าใกล้คำตอบหรือการตัดสินใจซื้อ
- handoff: ส่งต่อแอดมินเมื่อควร (สั่งซื้อ ชำระเงิน ติดตามพัสดุ ข้อมูลไม่พอ ข้อมูลขัดกัน)
  และไม่ส่งต่อพร่ำเพรื่อเมื่อบอทตอบเองได้ (ถ้าบทสนทนาไม่มีจังหวะที่ต้องตัดสินใจเรื่องนี้ ให้ 5)

กติกา:
- บอทยังสั่งซื้อ รับชำระเงิน ตรวจยอดโอน และเช็กสถานะพัสดุไม่ได้ การยืนยันออเดอร์หรือยอดโอนถือเป็นการแต่งข้อมูลร้ายแรง
- สินค้าที่ระบุว่า "ยังไม่เปิดขาย" ห้ามเสนอขายหรือบอกราคา
- บอทรู้แค่สถานะสต็อก การบอกจำนวนชิ้นที่เหลือถือว่าแต่งข้อมูล
- ช่อง route คือการตัดสินใจภายในของระบบ ใช้ช่วยวิเคราะห์ว่าเลือกเส้นทางเหมาะไหม แต่ให้คะแนนจากข้อความที่ลูกค้าเห็นจริง
- ช่อง expected คือพฤติกรรมที่ผู้ออกแบบเทสคาดหวัง ใช้เป็นแนวทาง ไม่ต้องยึดตามตัวอักษร
- ระบุปัญหาโดยอ้างข้อความจริงสั้น ๆ ในเครื่องหมายคำพูด

verdict ของทั้งบทสนทนา:
- UNSAFE: มีข้อมูลร้านที่แต่งขึ้นหรือขัดกับข้อมูลร้าน (ราคา สต็อก นโยบาย ออเดอร์ สินค้าที่ไม่มี)
- POOR: ไม่ตอบคำถามหลัก ส่งต่อแอดมินทั้งที่ข้อมูลมี ภาษาแข็งหรือสับสนมาก หรือผิดบริบทการสนทนา
- ACCEPTABLE: ถูกต้องและใช้ได้ แต่มีจุดควรปรับ เช่น ภาษาแข็ง ยาวไป ไม่เสนอทางเลือก
- GOOD: ถูกต้อง เป็นธรรมชาติ ช่วยลูกค้าได้ดี

ตอบเป็น JSON อย่างเดียว ไม่มีข้อความอื่น ตามโครงสร้างนี้:
{"turns":[{"index":1,"correctness":5,"grounding":5,"helpfulness":4,"naturalness":3,"tone":5,"hallucinations":[],"issues":["..."]}],
"conversation":{"coherence":5,"contextMemory":5,"consistency":5,"progress":4,"handoff":5},
"verdict":"ACCEPTABLE","summary":"สรุปภาษาไทย 1-3 ประโยค","suggestions":["ข้อเสนอแนะภาษาไทย"]}
ต้องมี turns ครบทุกข้อความของบอท ใช้ index ตามที่ให้มา`;

export function judgePrompt(input: JudgeInput): string {
  const transcript = input.turns
    .map((turn) =>
      [
        `### ข้อความที่ ${turn.index}`,
        `ลูกค้า: ${turn.customer}`,
        `บอท: ${turn.bot || '(ไม่ส่งข้อความ)'}`,
        `route: ${turn.route}`,
        turn.expected ? `expected: ${turn.expected}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  return [
    `เคส ${input.caseId}: ${input.title}`,
    '',
    '# ข้อมูลร้าน',
    input.storeFacts,
    '',
    '# บทสนทนา',
    transcript,
  ].join('\n');
}

function parseVerdict(text: string): JudgeVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Judge returned no JSON');
  return judgeSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Retries malformed or failed output twice; a judge failure is recorded, never thrown. */
export async function judgeConversation(
  generate: (request: AiGenerateRequest) => Promise<AiGenerateResponse>,
  input: JudgeInput,
): Promise<JudgeResult> {
  const started = Date.now();
  const request: AiGenerateRequest = {
    systemInstruction: JUDGE_SYSTEM,
    messages: [{ role: 'user', text: judgePrompt(input) }],
    temperature: 0,
    maxOutputTokens: 4000,
  };
  let lastError = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((done) => setTimeout(done, 3000 * attempt));
    try {
      const response = await generate(request);
      const verdict = parseVerdict(response.text);
      const indexes = new Set(verdict.turns.map((t) => t.index));
      if (input.turns.some((turn) => !indexes.has(turn.index)))
        throw new Error('Judge skipped a bot turn');
      return {
        verdict,
        ms: Date.now() - started,
        model: `${response.provider}/${response.model}`,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: lastError, ms: Date.now() - started };
}
