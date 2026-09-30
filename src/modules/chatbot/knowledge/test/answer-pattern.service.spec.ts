import { AnswerPatternService } from '../answer-pattern.service';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { configStub, makePattern } from './knowledge.fixtures';
import { thaiTerms } from '../thai-bm25';

const setup = (
  rows: ReturnType<typeof makePattern>[] = [],
  env: Record<string, string> = {},
) => {
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    findMany,
    service: new AnswerPatternService(
      { answerPattern: { findMany } } as unknown as PrismaService,
      configStub(env),
    ),
  };
};

describe('Thai BM25 candidates', () => {
  const { service } = setup();

  it('keeps Thai relation, availability and ability words in customer queries', () => {
    expect(thaiTerms('มีประกันหรือไม่ และรับเองได้ในร้าน')).toEqual(
      expect.arrayContaining(['มี', 'หรือ', 'และ', 'ได้', 'ใน']),
    );
  });

  it('ranks an alternative delivery FAQ above a combined-service FAQ for หรือ', () => {
    const result = service.findMatchesFromPatterns(
      'ลูกค้ารับเองหรือจัดส่งได้ไหม',
      [
        makePattern({
          id: 'alternative',
          title: '',
          keywords: ['รับสินค้า'],
          questionExamples: ['รับเองหรือจัดส่ง'],
          answer: 'เลือกรับเองหรือจัดส่งได้',
        }),
        makePattern({
          id: 'combined',
          title: '',
          keywords: ['รับสินค้า'],
          questionExamples: ['รับเองและจัดส่ง'],
          answer: 'รับเองและจัดส่งได้',
        }),
      ],
    );
    expect(result[0].id).toBe('alternative');
    expect(result[0].metadata?.exactMatch).toBe(false);
  });

  it.each(['ไหม', 'มั้ย'])(
    'keeps %s as a yes/no question signal when ranking non-exact FAQs',
    (particle) => {
      const result = service.findMatchesFromPatterns(
        `ร้านส่งฟรี${particle}ครับ`,
        [
          makePattern({
            id: 'yes-no',
            title: '',
            keywords: ['ส่งฟรี'],
            questionExamples: [`ส่งฟรี${particle}`],
            answer: 'ส่งฟรีเมื่อซื้อครบ 500 บาท',
          }),
          makePattern({
            id: 'amount',
            title: '',
            keywords: ['ส่งฟรี'],
            questionExamples: ['ส่งฟรีเท่าไร'],
            answer: 'ค่าส่ง 40 บาท',
          }),
        ],
      );
      expect(result[0].id).toBe('yes-no');
      expect(result[0].metadata?.exactMatch).toBe(false);
    },
  );

  it('ranks the specific fee fact above a broad return policy for unspaced Thai', () => {
    const result = service.findMatchesFromPatterns(
      'คืนสินค้ามีค่าธรรมเนียมเท่าไร',
      [
        makePattern({
          id: 'policy',
          title: 'คืนสินค้า',
          keywords: ['คืนสินค้า'],
          answer: 'คืนสินค้าได้ภายใน 7 วัน',
        }),
        makePattern({
          id: 'fee',
          title: 'ค่าธรรมเนียมคืนสินค้า',
          keywords: ['ค่าธรรมเนียม'],
          answer: 'คืนสินค้ามีค่าธรรมเนียม 40 บาท',
        }),
      ],
    );
    expect(result.map((item) => item.id)).toEqual(['fee', 'policy']);
    expect(result[0].metadata?.rawScore).toBeGreaterThan(
      result[1].metadata?.rawScore as number,
    );
  });

  it('does not match หมอน inside หาหมอนะ', () => {
    expect(
      service.findMatchesFromPatterns('นอนไม่หลับควรไปหาหมอนะ', [
        makePattern({
          title: 'หมอน',
          keywords: ['หมอน'],
          answer: 'หมอนราคา 590 บาท',
        }),
      ]),
    ).toEqual([]);
  });

  it('finds a fact appearing only in the answer', () => {
    expect(
      service
        .findMatchesFromPatterns('เปลี่ยนวันนัดหมายได้ไหม', [
          makePattern({
            id: 'appointment',
            title: 'บริการ',
            keywords: [],
            questionExamples: [],
            answer: 'สามารถเปลี่ยนวันนัดหมายได้',
          }),
        ])
        .map((item) => item.id),
    ).toEqual(['appointment']);
  });

  it('filters scope and empty answers before scoring', () => {
    const matching = { keywords: ['ค่าส่ง'] };
    const result = service.findMatchesFromPatterns('ค่าส่งเท่าไร', [
      makePattern({ id: 'ok', ...matching }),
      makePattern({ id: 'inactive', active: false, ...matching }),
      makePattern({ id: 'other-tenant', tenantId: 'other', ...matching }),
      makePattern({ id: 'other-language', language: 'en', ...matching }),
      makePattern({ id: 'blank', answer: ' ', ...matching }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['ok']);
  });

  it('does not use legacy rows when tenant is configured', () => {
    const tenantId = 'dcfee647-fc7f-450e-ba99-a968bfd29601';
    const scoped = setup([], { KNOWLEDGE_TENANT_ID: tenantId }).service;
    expect(
      scoped
        .findMatchesFromPatterns('ค่าส่ง', [
          makePattern({ id: 'legacy', keywords: ['ค่าส่ง'] }),
          makePattern({ id: 'mine', tenantId, keywords: ['ค่าส่ง'] }),
        ])
        .map((item) => item.id),
    ).toEqual(['mine']);
  });

  it('ignores blank queries and caps ranked candidates at 20', () => {
    expect(service.findMatchesFromPatterns('!!!', [makePattern()])).toEqual([]);
    const rows = Array.from({ length: 25 }, (_, index) =>
      makePattern({ id: `p-${index}`, keywords: ['ค่าส่ง'] }),
    );
    expect(service.findMatchesFromPatterns('ค่าส่ง', rows)).toHaveLength(20);
  });
});

describe('exact FAQ remains separate', () => {
  const { service } = setup();
  const exact = (overrides: Parameters<typeof makePattern>[0] = {}) =>
    makePattern({ title: '', questionExamples: ['ส่งฟรีไหม'], ...overrides });

  it('places an approved exact example first and permits DIRECT', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      makePattern({ id: 'lexical', keywords: ['ส่งฟรี', 'ส่งฟรีไหม'] }),
      exact({ id: 'exact' }),
    ]);
    expect(result[0].id).toBe('exact');
    expect(result[0].metadata).toMatchObject({
      exactMatch: true,
      safeDirect: true,
      matchTypes: ['EXACT'],
    });
  });

  it('uses priority for exact FAQs and blocks conflicting answers', () => {
    const result = service.findMatchesFromPatterns('ส่งฟรีไหม', [
      exact({ id: 'low', priority: 1, answer: 'ส่งฟรีทุกออเดอร์' }),
      exact({ id: 'high', priority: 9, answer: 'ส่งฟรีเมื่อซื้อครบ 500' }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['high', 'low']);
    expect(
      result.every(
        (item) =>
          item.metadata?.safeDirect === false &&
          item.metadata?.ambiguousExact === true,
      ),
    ).toBe(true);
  });

  it('disables DIRECT at scan cap, for broad questions and for micro facts', () => {
    const capped = [
      exact(),
      ...Array.from({ length: 499 }, (_, index) =>
        makePattern({ id: `f-${index}`, keywords: ['ไม่เกี่ยว'] }),
      ),
    ];
    expect(
      service.findMatchesFromPatterns('ส่งฟรีไหม', capped)[0].metadata
        ?.safeDirect,
    ).toBe(false);
    expect(
      service.findMatchesFromPatterns('ราคา', [
        makePattern({ questionExamples: ['ราคา'] }),
      ])[0].metadata?.safeDirect,
    ).toBe(false);
    expect(
      service.findMatchesFromPatterns(
        'ส่งฟรีไหม',
        [exact()],
        'DATABASE',
        'MICRO_KNOWLEDGE',
      )[0].metadata?.safeDirect,
    ).toBe(false);
  });
});

describe('database contract', () => {
  it('reads only active scoped rows and labels results DATABASE', async () => {
    const { service, findMany } = setup([
      makePattern({ keywords: ['ค่าส่ง'] }),
    ]);
    const result = await service.findMatches('ค่าส่งเท่าไร');
    expect(findMany).toHaveBeenCalledWith({
      where: { active: true, tenantId: null, language: 'th' },
      take: 500,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
    expect(result[0].metadata?.retrievalLayer).toBe('DATABASE');
  });

  it('does not read DB for an empty query and passes relationship keys through', async () => {
    const { service, findMany } = setup();
    expect(await service.findMatches(' ')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    const [item] = service.findMatchesFromPatterns('ค่าส่ง', [
      makePattern({
        keywords: ['ค่าส่ง'],
        entityKey: 'model-a',
        topicKey: 'fee',
        renderMode: 'REWRITE',
      }),
    ]);
    expect(item.renderMode).toBe('REWRITE');
    expect(item.metadata).toMatchObject({
      entityKey: 'model-a',
      topicKey: 'fee',
    });
  });
});
