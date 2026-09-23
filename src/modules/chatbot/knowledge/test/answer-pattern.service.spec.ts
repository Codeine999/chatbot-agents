/**
 * AnswerPatternService — ตัวจับคู่คำถามแบบไม่ใช้ embedding (ไม่มีค่า provider)
 * ใช้ร่วมกันทั้ง AnswerPattern และ MicroKnowledge
 *
 * สองทางเข้า:
 *   findMatches(message)            อ่าน DB เอง (active + scope, 500 แถว) → ป้าย DATABASE
 *   findMatchesFromPatterns(...)    รับแถวที่มีอยู่แล้ว (cache / MicroKnowledge)
 *
 * รายการ use case ที่ไฟล์นี้คุมไว้ เรียงตามลำดับที่โค้ดทำงานจริง
 *
 * 1) ทางเข้าที่อ่าน DB — describe 'findMatches (อ่านจากฐานข้อมูล)'
 *    - where {active, tenantId, language} + take 500 + เรียง priority → updatedAt
 *    - ข้อความว่าง ไม่ยิง query
 *    - ผลลัพธ์ติดป้าย retrievalLayer = DATABASE
 *
 * 2) ด่านกรองก่อนคิดคะแนน — describe 'ขอบเขต tenant/ภาษา' + 'น้ำหนักคะแนน'
 *    - normalize แล้วว่าง (ช่องว่าง/สัญลักษณ์ล้วน) → คืน []
 *    - ตัด active:false / tenant อื่น / ภาษาอื่น / คำตอบว่าง
 *    - ตั้ง KNOWLEDGE_TENANT_ID แล้ว แถว legacy (tenant null) ต้องไม่ถูกใช้
 *    - คะแนนต่ำกว่า MIN_MATCH_SCORE (2) ถือเป็นสัญญาณรบกวน ตัดทิ้ง
 *
 * 3) คะแนน keyword — describe 'น้ำหนักคะแนน' + 'รายละเอียดการจับคู่'
 *    - ตรงทั้งข้อความ 5 / ตรงทั้งคำ 4 / อยู่ข้างในข้อความ 3 / keyword คลุมคำ 1.5
 *    - หลาย keyword ใช้ช่องที่ดีที่สุด ไม่ใช่เอามาบวกกัน
 *    - โบนัสคำละ 0.5 เพดาน 1
 *    - keyword ว่าง/สัญลักษณ์ล้วน ถูกข้ามและไม่นับเป็นโบนัส
 *
 * 4) คะแนนคำถามตัวอย่าง — describe 'น้ำหนักคะแนน' + 'รายละเอียดการจับคู่'
 *    - ตรงทั้งประโยค 5 / คลุมกันไปมา 2.5 (ทั้งสองทิศทาง)
 *    - คำซ้ำคิดตามสัดส่วน เพดาน 2 (ซ้ำไม่ครบไปไม่ถึงเกณฑ์)
 *    - หลายตัวอย่างใช้ช่องที่ดีที่สุด ตัวอย่างว่างถูกข้าม
 *
 * 5) ช่องคะแนนอื่น — describe 'สัญญาณอื่นนอกจาก keyword/คำถามตัวอย่าง'
 *    - intentKey +2, title +1, category +1, description +0.5 (คลุมข้อความ หรือมีแค่บางคำ)
 *    - ช่องที่เป็น null ไม่คิดคะแนนและต้องไม่พัง / ทุกช่องบวกกันได้
 *
 * 6) กฎการจับคู่ข้อความ — describe 'รายละเอียดการจับคู่'
 *    - คำยาว 1 ตัวอักษรไม่ถูกใช้จับคู่ทั้งสองฝั่ง (MIN_CONTAINS_LENGTH, tokenize)
 *    - ไม่สนตัวพิมพ์เล็กใหญ่และเครื่องหมายวรรคตอน
 *
 * 7) การตัดสิน exact — describe 'safeDirect' + 'รายละเอียดการจับคู่'
 *    - ตรงคำถามตัวอย่างทั้งประโยคเท่านั้นจึงเป็น exact
 *    - คำกว้างใน BROAD_DIRECT_QUERIES ไม่นับ exact (ทั้ง 'ราคา' และ 'price')
 *
 * 8) การจัดอันดับ — describe 'การจัดอันดับ' + 'ลำดับเมื่อคะแนนเท่ากัน'
 *    - exact มาก่อนคะแนนสูงเสมอ
 *    - ในกลุ่ม exact ใช้ priority, priority เท่ากันคงลำดับเดิมจาก DB (ผลลัพธ์นิ่ง)
 *    - นอกกลุ่ม exact ใช้คะแนนแล้วค่อย priority
 *    - คืนไม่เกิน MAX_RETRIEVAL_CANDIDATES (20)
 *
 * 9) safeDirect — ใบอนุญาตตอบลูกค้าตรง ๆ โดยไม่ผ่านโมเดล (จุดเสี่ยงที่สุดของไฟล์)
 *    - exact เดี่ยว ๆ ได้สิทธิ์
 *    - exact หลายใบที่คำตอบต่างกัน = ambiguousExact ห้ามตอบตรง
 *    - exact หลายใบที่คำตอบเหมือนกัน ยังตอบตรงได้
 *    - สแกนชนเพดาน 500 แถว = พิสูจน์ไม่ได้ว่าไม่มีคู่แข่ง ห้ามตอบตรง
 *    - MICRO_KNOWLEDGE ไม่มีสิทธิ์ และไม่ถูกตีตราคลุมเครือ
 *
 * 10) สัญญาที่ส่งต่อให้ชั้น retrieval — describe 'ข้อมูลที่ส่งต่อให้ชั้นถัดไป'
 *    - metadata ครบ: tenantId, language, active, entityKey, topicKey, priority,
 *      intentKey, questionExamples, rawScore, retrievalLayer (ปริยาย CACHE)
 *    - matchTypes = ['KEYWORD'] หรือ ['EXACT']
 *    - content = description ถ้าไม่มีจึงใช้ title
 *    - renderMode ส่งต่อตามเดิม (REWRITE ถูกกันทางลัดที่ชั้น retrieval ไม่ใช่ที่นี่)
 *
 * จงใจไม่เทสต์: ข้อความใน logger.debug (เป็น diagnostic ไม่ใช่สัญญา) และเรื่องเวลา/ประสิทธิภาพ
 */
import { AnswerPatternService } from '../answer-pattern.service';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { configStub, makePattern } from './knowledge.fixtures';
import { describe, it, expect, jest } from '@jest/globals';

type FindManyArgs = {
  where?: Record<string, unknown>;
  take?: number;
  orderBy?: unknown;
};

const makeService = (
  findMany = jest
    .fn<(args: FindManyArgs) => Promise<unknown[]>>()
    .mockResolvedValue([]),
  env: Record<string, string> = {},
) => ({
  findMany,
  service: new AnswerPatternService(
    { answerPattern: { findMany } } as unknown as PrismaService,
    configStub(env),
  ),
});

/** คะแนนอย่างเดียว ไม่สนใจชื่อ/คำอธิบาย จึงเว้นว่างไว้กันคะแนนแถมจากช่องอื่น */
const scoreOf = (
  service: AnswerPatternService,
  message: string,
  pattern: Parameters<typeof makePattern>[0],
) =>
  service.findMatchesFromPatterns(message, [
    makePattern({ title: '', ...pattern }),
  ])[0]?.score;

describe('AnswerPatternService — น้ำหนักคะแนน', () => {
  const { service } = makeService();

  it('ทั้งข้อความตรงกับ keyword = 5', () => {
    expect(scoreOf(service, 'ราคา', { keywords: ['ราคา'] })).toBe(5);
  });

  it('คำใดคำหนึ่งในข้อความตรงกับ keyword = 4', () => {
    expect(scoreOf(service, 'ค่าส่ง เท่าไร', { keywords: ['ค่าส่ง'] })).toBe(4);
  });

  it('ข้อความไทยที่ไม่เว้นวรรคแต่มี keyword อยู่ข้างใน = 3', () => {
    expect(scoreOf(service, 'ค่าส่งเท่าไรครับ', { keywords: ['ค่าส่ง'] })).toBe(
      3,
    );
  });

  it('keyword ยาวกว่าและคลุมคำในข้อความ = 1.5 (ต่ำกว่าเกณฑ์ ตกไปถ้ามาเดี่ยว ๆ)', () => {
    expect(
      scoreOf(service, 'ค่าส่ง', { keywords: ['ค่าส่งต่างจังหวัด'] }),
    ).toBeUndefined();
  });

  it('จับได้หลาย keyword ได้โบนัสคำละ 0.5 แต่ไม่เกิน 1', () => {
    const twoLoose = scoreOf(service, 'ค่าส่ง', {
      keywords: ['ค่าส่งต่างจังหวัด', 'ค่าส่งในกรุงเทพ'],
    });
    const manyExact = scoreOf(service, 'ราคา ส่ง ของ ด่วน', {
      keywords: ['ราคา', 'ส่ง', 'ของ', 'ด่วน'],
    });

    expect(twoLoose).toBe(2); // 1.5 + 0.5
    expect(manyExact).toBe(5); // 4 + โบนัสที่ถูก cap ไว้ที่ 1
  });

  it('คำถามตัวอย่างที่ตรงทั้งประโยค = 5 และถือเป็น exact match', () => {
    const [item] = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({ title: '', questionExamples: ['ส่งฟรีไหม'] }),
    ]);

    expect(item.score).toBe(5);
    expect(item.metadata?.exactMatch).toBe(true);
    expect(item.metadata?.matchTypes).toEqual(['EXACT']);
  });

  it('คำถามตัวอย่างที่เป็นส่วนหนึ่งของข้อความ = 2.5 และไม่ใช่ exact', () => {
    const [item] = service.findMatchesFromPatterns('ตกลงว่าส่งฟรีไหมครับ', [
      makePattern({ title: '', questionExamples: ['ส่งฟรีไหม'] }),
    ]);

    expect(item.score).toBe(2.5);
    expect(item.metadata?.exactMatch).toBe(false);
  });

  it('คำซ้ำกับคำถามตัวอย่างคิดตามสัดส่วน สูงสุด 2 และซ้ำไม่ครบก็ไม่ถึงเกณฑ์', () => {
    // สลับลำดับคำ เพื่อไม่ให้ไปเข้าเงื่อนไข "เป็นส่วนหนึ่งของกัน" ที่ได้ 2.5
    const allTokensShared = scoreOf(service, 'สมาชิก สมัคร', {
      questionExamples: ['สมัคร สมาชิก ต้องทำอะไรบ้าง'],
    });
    const twoOfThreeShared = scoreOf(service, 'สมาชิก สมัคร ยังไง', {
      questionExamples: ['สมัคร สมาชิก ต้องทำอะไรบ้าง'],
    });

    expect(allTokensShared).toBe(2);
    // 2 * (2/3) = 1.33 ยังไม่ถึงเกณฑ์ 2 จึงถูกตัดทิ้ง คำซ้ำอย่างเดียวพาไปไม่ถึงคำตอบ
    expect(twoOfThreeShared).toBeUndefined();
  });

  it('คะแนนต่ำกว่า 2 ถือเป็นสัญญาณรบกวน ตัดทิ้ง', () => {
    expect(
      service.findMatchesFromPatterns('เรื่องอื่นไปเลย', [
        makePattern({ title: 'ราคา', description: 'เรื่องอื่นไปเลย' }),
      ]),
    ).toEqual([]);
  });

  it('ข้อความว่างหรือมีแต่เครื่องหมายวรรคตอน ไม่ต้องค้นเลย', () => {
    expect(service.findMatchesFromPatterns('   ', [makePattern()])).toEqual([]);
    expect(service.findMatchesFromPatterns('!!!', [makePattern()])).toEqual([]);
  });
});

describe('AnswerPatternService — ขอบเขต tenant/ภาษา', () => {
  it('ตัดแถวนอก scope และแถวที่ไม่มีคำตอบทิ้งก่อนคิดคะแนน', () => {
    const { service } = makeService();
    const matching = { keywords: ['ราคา'] };

    const result = service.findMatchesFromPatterns('ราคา', [
      makePattern({ id: 'ok', ...matching }),
      makePattern({ id: 'inactive', active: false, ...matching }),
      makePattern({ id: 'other-tenant', tenantId: 'tenant-a', ...matching }),
      makePattern({ id: 'other-language', language: 'en', ...matching }),
      makePattern({ id: 'blank-answer', answer: '   ', ...matching }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['ok']);
  });

  it('เมื่อ deployment ตั้ง tenant ไว้ แถว legacy (tenant null) ต้องไม่ถูกใช้', () => {
    const tenantId = 'dcfee647-fc7f-450e-ba99-a968bfd29601';
    const { service } = makeService(undefined, {
      KNOWLEDGE_TENANT_ID: tenantId,
    });

    const result = service.findMatchesFromPatterns('ราคา', [
      makePattern({ id: 'legacy', keywords: ['ราคา'] }),
      makePattern({ id: 'mine', tenantId, keywords: ['ราคา'] }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['mine']);
  });
});

describe('AnswerPatternService — การจัดอันดับ', () => {
  const { service } = makeService();

  it('exact match มาก่อนแถวที่คะแนนดิบสูงกว่าเสมอ', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({
        id: 'loud',
        title: '',
        keywords: ['ส่งฟรีไหม', 'ส่ง', 'ฟรี'],
      }),
      makePattern({ id: 'exact', title: '', questionExamples: ['ส่งฟรีไหม'] }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['exact', 'loud']);
  });

  it('ในกลุ่ม exact ด้วยกัน ใช้ priority ตัดสิน', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({
        id: 'low',
        title: '',
        priority: 1,
        questionExamples: ['ส่งฟรีไหม'],
      }),
      makePattern({
        id: 'high',
        title: '',
        priority: 9,
        questionExamples: ['ส่งฟรีไหม'],
      }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['high', 'low']);
  });

  it('คืนไม่เกิน 20 รายการ', () => {
    const patterns = Array.from({ length: 25 }, (_, index) =>
      makePattern({ id: `p-${index}`, title: '', keywords: ['ราคา'] }),
    );

    expect(service.findMatchesFromPatterns('ราคา', patterns)).toHaveLength(20);
  });
});

describe('AnswerPatternService — safeDirect (สิทธิ์ตอบตรงโดยไม่ผ่านโมเดล)', () => {
  const { service } = makeService();
  const exact = (overrides: Parameters<typeof makePattern>[0] = {}) =>
    makePattern({ title: '', questionExamples: ['ส่งฟรีไหม'], ...overrides });

  it('exact เดี่ยว ๆ ได้สิทธิ์ตอบตรง', () => {
    const [item] = service.findMatchesFromPatterns('ส่งฟรีไหม', [exact()]);

    expect(item.metadata?.safeDirect).toBe(true);
    expect(item.metadata?.ambiguousExact).toBe(false);
  });

  it('exact สองแถวที่คำตอบต่างกัน = คลุมเครือ ห้ามตอบตรง', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      exact({ id: 'a', answer: 'ส่งฟรีทุกออเดอร์' }),
      exact({ id: 'b', answer: 'ส่งฟรีเมื่อซื้อครบ 500' }),
    ]);

    expect(result.map((item) => item.metadata?.safeDirect)).toEqual([
      false,
      false,
    ]);
    expect(result.map((item) => item.metadata?.ambiguousExact)).toEqual([
      true,
      true,
    ]);
  });

  it('exact สองแถวที่คำตอบเหมือนกัน ถือว่าไม่ขัดกัน ตอบตรงได้', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      exact({ id: 'a', answer: 'ส่งฟรีทุกออเดอร์' }),
      exact({ id: 'b', answer: 'ส่งฟรีทุกออเดอร์!' }),
    ]);

    expect(result.map((item) => item.metadata?.safeDirect)).toEqual([
      true,
      true,
    ]);
  });

  it('สแกนชนเพดาน 500 แถว = พิสูจน์ไม่ได้ว่าไม่มีคู่แข่ง ห้ามตอบตรง', () => {
    const patterns = [
      exact(),
      ...Array.from({ length: 499 }, (_, index) =>
        makePattern({
          id: `filler-${index}`,
          title: '',
          keywords: ['ไม่เกี่ยว'],
        }),
      ),
    ];

    const [item] = service.findMatchesFromPatterns('ส่งฟรีไหม', patterns);

    expect(item.metadata?.safeDirect).toBe(false);
  });

  it('คำถามกว้างอย่าง "ราคา" ไม่นับเป็น exact แม้จะตรงกับคำถามตัวอย่าง', () => {
    const [item] = service.findMatchesFromPatterns('ราคา', [
      makePattern({ title: '', questionExamples: ['ราคา'] }),
    ]);

    expect(item.metadata?.exactMatch).toBe(false);
    expect(item.metadata?.safeDirect).toBe(false);
  });

  it('MicroKnowledge เป็นเกร็ดข้อมูล ไม่ใช่คำตอบสำเร็จรูป จึงไม่มีสิทธิ์ตอบตรง', () => {
    const [item] = service.findMatchesFromPatterns(
      'ส่งฟรีไหม',
      [exact()],
      'DATABASE',
      'MICRO_KNOWLEDGE',
    );

    expect(item.source).toBe('MICRO_KNOWLEDGE');
    expect(item.metadata?.safeDirect).toBe(false);
  });
});

describe('AnswerPatternService.findMatches (อ่านจากฐานข้อมูล)', () => {
  it('ค้นเฉพาะแถวที่ active และอยู่ใน scope เรียงตาม priority จำกัด 500 แถว', async () => {
    const findMany = jest
      .fn<(args: FindManyArgs) => Promise<unknown[]>>()
      .mockResolvedValue([makePattern({ title: '', keywords: ['ราคา'] })]);
    const { service } = makeService(findMany);

    const result = await service.findMatches('ราคา');

    expect(findMany).toHaveBeenCalledWith({
      where: { active: true, tenantId: null, language: 'th' },
      take: 500,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
    expect(result[0].metadata?.retrievalLayer).toBe('DATABASE');
  });

  it('ข้อความว่าง ไม่ต้องยิง query', async () => {
    const findMany = jest
      .fn<(args: FindManyArgs) => Promise<unknown[]>>()
      .mockResolvedValue([]);
    const { service } = makeService(findMany);

    expect(await service.findMatches('   ')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('AnswerPatternService — สัญญาณอื่นนอกจาก keyword/คำถามตัวอย่าง', () => {
  const { service } = makeService();
  const message = 'ค่าส่งเท่าไร';

  it('intentKey ที่ปรากฏในข้อความ +2 (ผ่านเกณฑ์ได้ด้วยตัวเอง)', () => {
    expect(scoreOf(service, message, { intentKey: 'ค่าส่ง' })).toBe(2);
  });

  it('title +1 และ category +1 บวกเพิ่มจากช่องอื่น', () => {
    expect(
      scoreOf(service, message, { intentKey: 'ค่าส่ง', title: 'ค่าส่ง' }),
    ).toBe(3);
    expect(
      scoreOf(service, message, {
        intentKey: 'ค่าส่ง',
        title: 'ค่าส่ง',
        category: 'ค่าส่ง',
      }),
    ).toBe(4);
  });

  it('description ที่คลุมทั้งข้อความ +0.5', () => {
    expect(
      scoreOf(service, message, {
        intentKey: 'ค่าส่ง',
        description: 'รายละเอียดค่าส่งเท่าไรก็ตามแต่พื้นที่',
      }),
    ).toBe(2.5);
  });

  it('description ที่มีเพียงคำใดคำหนึ่งของข้อความ ก็ได้ +0.5', () => {
    expect(
      scoreOf(service, 'ค่าส่ง ด่วน', {
        intentKey: 'ค่าส่ง',
        description: 'ตารางค่าส่งของทุกพื้นที่',
      }),
    ).toBe(2.5);
  });

  it('ช่องที่เป็น null ไม่คิดคะแนนและต้องไม่พัง', () => {
    expect(
      scoreOf(service, message, {
        keywords: ['ค่าส่ง'],
        intentKey: null,
        category: null,
        description: null,
      }),
    ).toBe(3);
  });

  it('ทุกช่องรวมกันได้ในคำถามเดียว', () => {
    // keyword ตรงทั้งข้อความ 5 + intentKey 2 + title 1 + category 1
    expect(
      scoreOf(service, 'ค่าส่ง', {
        keywords: ['ค่าส่ง'],
        intentKey: 'ค่าส่ง',
        title: 'ค่าส่ง',
        category: 'ค่าส่ง',
      }),
    ).toBe(9);
  });
});

describe('AnswerPatternService — รายละเอียดการจับคู่', () => {
  const { service } = makeService();

  it('หลาย keyword คิดจากช่องที่ดีที่สุด ไม่ใช่เอามาบวกกัน', () => {
    // 5 (ตรงทั้งข้อความ) + โบนัสอีกคำ 0.5 ไม่ใช่ 5 + 1.5
    expect(scoreOf(service, 'ราคา', { keywords: ['ราคา', 'ราคาสินค้า'] })).toBe(
      5.5,
    );
  });

  it('keyword ที่เป็นช่องว่างหรือสัญลักษณ์ล้วน ถูกข้ามและไม่นับเป็นโบนัส', () => {
    expect(
      scoreOf(service, 'ค่าส่ง', { keywords: ['   ', '!!!', 'ค่าส่ง'] }),
    ).toBe(5);
  });

  it('คำ 1 ตัวอักษรไม่ถูกใช้จับคู่ ทั้งฝั่ง keyword และฝั่งข้อความ', () => {
    expect(scoreOf(service, 'กระเป๋า', { keywords: ['ก'] })).toBeUndefined();
    expect(scoreOf(service, 'ค่าส่ง ก', { keywords: ['ก'] })).toBeUndefined();
  });

  it('คำถามตัวอย่างที่ยาวกว่าและคลุมข้อความทั้งประโยค = 2.5 เช่นกัน', () => {
    expect(
      scoreOf(service, 'ส่งฟรี', { questionExamples: ['ส่งฟรีไหม'] }),
    ).toBe(2.5);
  });

  it('มีหลายคำถามตัวอย่าง ใช้ช่องที่ดีที่สุดและยังเป็น exact ได้', () => {
    const [item] = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({ title: '', questionExamples: ['ค่าส่ง', 'ส่งฟรีไหม'] }),
    ]);

    expect(item.score).toBe(5);
    expect(item.metadata?.exactMatch).toBe(true);
  });

  it('คำถามตัวอย่างที่ว่างเปล่า ถูกข้ามไปเฉย ๆ', () => {
    expect(
      scoreOf(service, 'ส่งฟรีไหม', {
        questionExamples: ['', '   ', 'ส่งฟรีไหม'],
      }),
    ).toBe(5);
  });

  it('ไม่สนตัวพิมพ์เล็กใหญ่และเครื่องหมายวรรคตอน', () => {
    expect(scoreOf(service, 'PRICE?', { keywords: ['price'] })).toBe(5);
  });

  it('คำกว้างภาษาอังกฤษก็ไม่นับเป็น exact เหมือนฝั่งไทย', () => {
    const [item] = service.findMatchesFromPatterns('price', [
      makePattern({ title: '', questionExamples: ['price'] }),
    ]);

    expect(item.metadata?.exactMatch).toBe(false);
  });
});

describe('AnswerPatternService — ลำดับเมื่อคะแนนเท่ากัน', () => {
  const { service } = makeService();

  it('exact ที่ priority เท่ากัน คงลำดับเดิมจาก DB/cache ไว้ (ผลลัพธ์นิ่ง)', () => {
    const rows = ['first', 'second'].map((id) =>
      makePattern({ id, title: '', questionExamples: ['ส่งฟรีไหม'] }),
    );

    expect(
      service.findMatchesFromPatterns('ส่งฟรีไหม', rows).map((item) => item.id),
    ).toEqual(['first', 'second']);
  });

  it('แถวที่ไม่ใช่ exact และคะแนนเท่ากัน ใช้ priority ตัดสิน', () => {
    const result = service.findMatchesFromPatterns('ค่าส่งเท่าไรครับ', [
      makePattern({ id: 'low', title: '', priority: 1, keywords: ['ค่าส่ง'] }),
      makePattern({ id: 'high', title: '', priority: 9, keywords: ['ค่าส่ง'] }),
    ]);

    expect(result.map((item) => item.id)).toEqual(['high', 'low']);
  });
});

describe('AnswerPatternService — ข้อมูลที่ส่งต่อให้ชั้นถัดไป', () => {
  const { service } = makeService();

  it('ส่ง metadata ครบชุดที่ชั้น retrieval ใช้ตรวจขอบเขตและข้อมูลขัดแย้ง', () => {
    const [item] = service.findMatchesFromPatterns('ค่าส่งเท่าไร', [
      makePattern({
        id: 'fact-1',
        title: '',
        keywords: ['ค่าส่ง'],
        intentKey: 'shipping_fee',
        category: 'shipping',
        entityKey: 'model-a',
        topicKey: 'fee',
        priority: 7,
        questionExamples: ['ค่าส่งเท่าไร '],
      }),
    ]);

    expect(item.metadata).toMatchObject({
      tenantId: null,
      language: 'th',
      active: true,
      entityKey: 'model-a',
      topicKey: 'fee',
      priority: 7,
      intentKey: 'shipping_fee',
      questionExamples: ['ค่าส่งเท่าไร '],
      rawScore: item.score,
      retrievalLayer: 'CACHE',
    });
  });

  it('ติดป้าย matchTypes ตามชนิดการจับคู่', () => {
    const [keywordItem] = service.findMatchesFromPatterns('ค่าส่งเท่าไร', [
      makePattern({ title: '', keywords: ['ค่าส่ง'] }),
    ]);
    const [exactItem] = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({ title: '', questionExamples: ['ส่งฟรีไหม'] }),
    ]);

    expect(keywordItem.metadata?.matchTypes).toEqual(['KEYWORD']);
    expect(exactItem.metadata?.matchTypes).toEqual(['EXACT']);
  });

  it('content ใช้ description ถ้าไม่มีจึงใช้ title', () => {
    const [withDescription] = service.findMatchesFromPatterns('ค่าส่งเท่าไร', [
      makePattern({
        title: 'หัวข้อ',
        description: 'คำอธิบาย',
        keywords: ['ค่าส่ง'],
      }),
    ]);
    const [withoutDescription] = service.findMatchesFromPatterns(
      'ค่าส่งเท่าไร',
      [
        makePattern({
          title: 'หัวข้อ',
          description: null,
          keywords: ['ค่าส่ง'],
        }),
      ],
    );

    expect(withDescription.content).toBe('คำอธิบาย');
    expect(withoutDescription.content).toBe('หัวข้อ');
  });

  it('renderMode ของแถวถูกส่งต่อไปให้ชั้นบนตัดสินใจ (REWRITE ห้ามตอบตรง)', () => {
    const [item] = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({
        title: '',
        renderMode: 'REWRITE',
        questionExamples: ['ส่งฟรีไหม'],
      }),
    ]);

    expect(item.renderMode).toBe('REWRITE');
    // ตัวจับคู่ยังให้ safeDirect ตามปกติ ชั้น retrieval เป็นคนกันทางลัดของ REWRITE
    expect(item.metadata?.safeDirect).toBe(true);
  });

  it('เกร็ดข้อมูลที่ exact ซ้ำกันหลายใบ ไม่ถูกตีตราคลุมเครือ เพราะไม่มีสิทธิ์ตอบตรงอยู่แล้ว', () => {
    const rows = [
      makePattern({
        id: 'a',
        title: '',
        questionExamples: ['ค่าส่งเท่าไร'],
        answer: '50 บาท',
      }),
      makePattern({
        id: 'b',
        title: '',
        questionExamples: ['ค่าส่งเท่าไร'],
        answer: '80 บาท',
      }),
    ];

    const result = service.findMatchesFromPatterns(
      'ค่าส่งเท่าไร',
      rows,
      'DATABASE',
      'MICRO_KNOWLEDGE',
    );

    expect(result.map((item) => item.metadata?.ambiguousExact)).toEqual([
      false,
      false,
    ]);
    expect(result.map((item) => item.metadata?.safeDirect)).toEqual([
      false,
      false,
    ]);
  });
});
