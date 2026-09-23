import { KnowledgeRetrievalService } from '../knowledge-retrieval.service';
import { AnswerPatternService } from '../answer-pattern.service';
import type { AnswerPatternCacheService } from '../answer-pattern-cache.service';
import type { MicroKnowledgeService } from '../micro-knowledge.service';
import type { SemanticSearchService } from '../semantic-search.service';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { PendingAiUsageError } from '../../../usage/billing/pending-ai-usage.error';
import type { KnowledgeItem } from '../../types/chat.types';
import {
  configStub,
  makeItem,
  makePattern,
  userMessage,
} from './knowledge.fixtures';

type Stubs = {
  cacheMatches: jest.Mock;
  databaseMatches: jest.Mock;
  microMatches: jest.Mock;
  semanticSearch: jest.Mock;
  cachedRows: jest.Mock;
};

const makeService = (
  overrides: Partial<{
    cache: KnowledgeItem[];
    database: KnowledgeItem[];
    micro: KnowledgeItem[];
    semantic: KnowledgeItem[];
    env: Record<string, string>;
  }> = {},
): { service: KnowledgeRetrievalService } & Stubs => {
  const cacheMatches = jest.fn().mockReturnValue(overrides.cache ?? []);
  const databaseMatches = jest.fn().mockResolvedValue(overrides.database ?? []);
  const microMatches = jest.fn().mockResolvedValue(overrides.micro ?? []);
  const semanticSearch = jest.fn().mockResolvedValue(overrides.semantic ?? []);
  const cachedRows = jest.fn().mockReturnValue([]);

  return {
    cacheMatches,
    databaseMatches,
    microMatches,
    semanticSearch,
    cachedRows,
    service: new KnowledgeRetrievalService(
      {
        findMatchesFromPatterns: cacheMatches,
        findMatches: databaseMatches,
      } as unknown as AnswerPatternService,
      { getAll: cachedRows } as unknown as AnswerPatternCacheService,
      { search: semanticSearch } as unknown as SemanticSearchService,
      { findMatches: microMatches } as unknown as MicroKnowledgeService,
      configStub(overrides.env),
    ),
  };
};

const directItem = (overrides: Partial<KnowledgeItem> = {}) =>
  makeItem({
    ...overrides,
    metadata: { safeDirect: true, exactMatch: true, ...overrides.metadata },
  });

describe('KnowledgeRetrievalService — ทางลัดตอบตรง', () => {
  it('คำตอบสำเร็จรูปที่ชัดเจนจาก cache ตอบได้เลย ไม่ต้องแตะ DB/embedding', async () => {
    const { service, databaseMatches, semanticSearch, microMatches } =
      makeService({
        cache: [directItem({ id: 'faq-1' })],
      });

    const result = await service.retrieve('ส่งฟรีไหม');

    expect(result.route).toBe('DIRECT');
    expect(result.matchType).toBe('EXACT');
    expect(result.selectedItems.map((item) => item.id)).toEqual(['faq-1']);
    expect(databaseMatches).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(microMatches).not.toHaveBeenCalled();
  });

  it('cache ไม่เจอ แต่ DB เจอคำตอบสำเร็จรูป ก็ยังตอบตรงได้โดยไม่ต้องฝังคำค้น', async () => {
    const { service, semanticSearch } = makeService({
      database: [directItem({ id: 'faq-2' })],
    });

    const result = await service.retrieve('ส่งฟรีไหม');

    expect(result.route).toBe('DIRECT');
    expect(result.selectedItems.map((item) => item.id)).toEqual(['faq-2']);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('แถวที่ตั้งให้เรียบเรียงใหม่ (REWRITE) ห้ามตอบตรง ต้องไปเส้นทาง RAG', async () => {
    const { service, semanticSearch } = makeService({
      database: [directItem({ id: 'faq-3', renderMode: 'REWRITE' })],
    });

    const result = await service.retrieve('ส่งฟรีไหม');

    expect(result.route).toBe('RAG');
    expect(semanticSearch).toHaveBeenCalled();
  });

  it('คำถามต่อเนื่องที่ถูกเติมรุ่นให้ ไม่ใช่คำถามที่ลูกค้าพิมพ์เอง จึงห้ามตอบตรง', async () => {
    const { service, cacheMatches } = makeService({
      cache: [directItem({ id: 'faq-4' })],
      database: [directItem({ id: 'faq-4' })],
    });

    const result = await service.retrieve('อันนี้ราคาเท่าไร', {
      recentMessages: [userMessage('สนใจ รุ่น A ครับ')],
    });

    expect(cacheMatches).toHaveBeenCalledWith(
      'รุ่น a\nอันนี้ราคาเท่าไร',
      expect.anything(),
      'CACHE',
    );
    expect(result.route).not.toBe('DIRECT');
  });

  it('มีคำตอบสำเร็จรูปสองใบที่ขัดกัน ต้องไม่เลือกใบใดใบหนึ่งมาตอบ', async () => {
    const { service } = makeService({
      cache: [
        // ประโยคเดียวกันเป๊ะ ต่างกันแค่ขั้ว — เป็นรูปแบบที่ตัวตรวจขัดแย้งจับได้
        directItem({ id: 'a', title: 'ส่งฟรี', answer: 'ส่งฟรีได้ทุกออเดอร์' }),
        directItem({
          id: 'b',
          title: 'ส่งฟรี',
          answer: 'ส่งฟรีไม่ได้ทุกออเดอร์',
        }),
      ],
    });

    const result = await service.retrieve('ส่งฟรีไหม');

    expect(result.route).toBe('LOW_CONFIDENCE');
    expect(result.fallbackReason).toBe('CONFLICTING_CANDIDATES');
    expect(result.selectedItems).toEqual([]);
  });
});

describe('KnowledgeRetrievalService — ไม่มีหลักฐานพอ', () => {
  it('อ้างถึงของเดิมแบบไม่รู้ว่าอันไหน ต้องถามกลับโดยไม่ค้นอะไรเลย', async () => {
    const { service, cacheMatches, semanticSearch } = makeService();

    const result = await service.retrieve('อันนี้ราคาเท่าไร');

    expect(result).toMatchObject({
      route: 'LOW_CONFIDENCE',
      fallbackReason: 'MISSING_USER_INFORMATION',
      matchType: 'NONE',
    });
    expect(cacheMatches).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('ข้อความที่เหลือแต่สัญลักษณ์ ไม่ต้องค้น', async () => {
    const { service, cacheMatches } = makeService();

    const result = await service.retrieve('!!!');

    expect(result.fallbackReason).toBe('NO_SEARCH_RESULTS');
    expect(cacheMatches).not.toHaveBeenCalled();
  });

  it('ค้นแล้วไม่มีอะไรผ่านเกณฑ์ ต้องบอกว่าไม่มีหลักฐาน ไม่ใช่เดาตอบ', async () => {
    const { service } = makeService();

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result).toMatchObject({
      route: 'LOW_CONFIDENCE',
      fallbackReason: 'NO_USABLE_EVIDENCE',
      matchType: 'NONE',
    });
  });
});

describe('KnowledgeRetrievalService — ด่านกรองก่อนนำไปใช้', () => {
  const ineligible = [
    makeItem({ id: 'other-tenant', metadata: { tenantId: 'tenant-a' } }),
    makeItem({ id: 'other-language', metadata: { language: 'en' } }),
    makeItem({ id: 'inactive', metadata: { active: false } }),
    makeItem({ id: 'blank-answer', answer: '   ' }),
    makeItem({ id: 'nan-score', score: Number.NaN }),
  ];

  it('ตัดแถวนอก scope / ปิดใช้งาน / ไม่มีคำตอบ / คะแนนเพี้ยน ออกทุกชั้น', async () => {
    const { service } = makeService({
      database: ineligible,
      semantic: ineligible,
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.items).toEqual([]);
    expect(result.fallbackReason).toBe('NO_USABLE_EVIDENCE');
  });

  it('คะแนนคำค้นต่ำกว่าพื้นสัญญาณรบกวน ไม่ถูกนำไปจัดอันดับ', async () => {
    const noisy = makeItem({ id: 'noisy', metadata: { rawScore: 2 } });
    const { service } = makeService({ database: [noisy] });

    expect((await service.retrieve('ค่าส่งเท่าไร')).items).toEqual([]);
  });

  it('ความใกล้เคียงของ vector ต่ำกว่าพื้น ไม่ถูกนำไปจัดอันดับ', async () => {
    const { service } = makeService({
      semantic: [
        makeItem({ id: 'far', metadata: { vectorSimilarity: 0.5 } }),
        makeItem({ id: 'near', metadata: { vectorSimilarity: 0.7 } }),
      ],
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.items.map((item) => item.id)).toEqual(['near']);
  });

  it('ปรับพื้นสัญญาณรบกวนได้จาก env ตาม deployment', async () => {
    const { service } = makeService({
      env: {
        KNOWLEDGE_LEXICAL_CANDIDATE_MIN_SCORE: '6',
        KNOWLEDGE_VECTOR_CANDIDATE_MIN_SIMILARITY: '0.9',
      },
      database: [makeItem({ id: 'lexical', metadata: { rawScore: 5 } })],
      semantic: [
        makeItem({ id: 'vector', metadata: { vectorSimilarity: 0.85 } }),
      ],
    });

    expect((await service.retrieve('ค่าส่งเท่าไร')).items).toEqual([]);
  });
});

describe('KnowledgeRetrievalService — รวมผลสองช่องทาง', () => {
  it('เจอทั้งจากคำค้นและ vector นับเป็นรายการเดียวและถือเป็น HYBRID', async () => {
    const shared = { id: 'same', source: 'ANSWER_PATTERN' as const };
    const { service } = makeService({
      database: [makeItem({ ...shared, metadata: { rawScore: 5 } })],
      semantic: [makeItem({ ...shared, metadata: { vectorSimilarity: 0.9 } })],
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.items).toHaveLength(1);
    expect(result.matchType).toBe('HYBRID');
    expect(result.items[0].metadata?.matchTypes).toEqual([
      'KEYWORD',
      'EMBEDDING',
    ]);
    // สองช่องทางรวมกันต้องได้คะแนนมากกว่ามาจากช่องทางเดียว
    expect(result.items[0].score).toBeCloseTo(2 / 61);
  });

  it('เจอจาก vector อย่างเดียว ถือเป็น EMBEDDING', async () => {
    const { service } = makeService({
      semantic: [makeItem({ id: 'v', metadata: { vectorSimilarity: 0.9 } })],
    });

    expect((await service.retrieve('ค่าส่งเท่าไร')).matchType).toBe(
      'EMBEDDING',
    );
  });

  it('ส่งหลักฐานให้โมเดลไม่เกิน 3 ชิ้น', async () => {
    const { service } = makeService({
      database: Array.from({ length: 5 }, (_, index) =>
        makeItem({ id: `k-${index}`, metadata: { rawScore: 5 - index * 0.1 } }),
      ),
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.items).toHaveLength(5);
    expect(result.selectedItems).toHaveLength(3);
    expect(result.route).toBe('RAG');
  });

  it('ข้ามหลักฐานที่ยาวเกินงบตัวอักษร แต่ยังหยิบชิ้นที่พอดีต่อได้ (ไม่ตัดข้อความ)', async () => {
    const { service } = makeService({
      database: [
        makeItem({
          id: 'huge',
          answer: 'ก'.repeat(12_001),
          metadata: { rawScore: 9 },
        }),
        makeItem({ id: 'small', metadata: { rawScore: 8 } }),
      ],
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.selectedItems.map((item) => item.id)).toEqual(['small']);
  });

  it('รายงานคะแนนและช่องว่างอันดับ 1-2 ไว้ให้ชั้นตัดสินใจใช้ต่อ', async () => {
    const { service } = makeService({
      database: [
        makeItem({ id: 'a', metadata: { rawScore: 9 } }),
        makeItem({ id: 'b', metadata: { rawScore: 8 } }),
      ],
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.topScores).toHaveLength(2);
    expect(result.scoreGap).toBeCloseTo(
      result.topScores[0] - result.topScores[1],
    );
  });
});

describe('KnowledgeRetrievalService — ข้อมูลขัดแย้ง', () => {
  const fact = (
    id: string,
    answer: string,
    metadata: Record<string, unknown> = {},
  ) =>
    makeItem({
      id,
      source: 'MICRO_KNOWLEDGE',
      title: 'เสื้อรุ่น A',
      answer,
      metadata: { rawScore: 5, entityKey: 'model-a', ...metadata },
    });

  it('ข้อเท็จจริงเดียวกันแต่กลับขั้ว (ได้/ไม่ได้) = ขัดแย้ง ห้ามตอบ', async () => {
    const { service } = makeService({
      micro: [fact('a', 'ซักเครื่องได้'), fact('b', 'ซักเครื่องไม่ได้')],
    });

    const result = await service.retrieve('ซักเครื่องได้ไหม');

    expect(result.route).toBe('LOW_CONFIDENCE');
    expect(result.fallbackReason).toBe('CONFLICTING_CANDIDATES');
    expect(result.selectedItems).toEqual([]);
  });

  it('ตัวเลขต่างกันในประโยคแบบเดียวกันและหัวข้อเดียวกัน = ขัดแย้ง', async () => {
    const { service } = makeService({
      micro: [
        fact('a', 'ค่าส่ง 50 บาท', { topicKey: 'fee' }),
        fact('b', 'ค่าส่ง 80 บาท', { topicKey: 'fee' }),
      ],
    });

    expect((await service.retrieve('ค่าส่งเท่าไร')).fallbackReason).toBe(
      'CONFLICTING_CANDIDATES',
    );
  });

  it('คนละเงื่อนไข (ถ้า/เมื่อ/กรณี) ไม่ใช่ข้อมูลขัดแย้ง ปล่อยให้โมเดลอธิบายได้', async () => {
    const { service } = makeService({
      micro: [
        fact('a', 'ถ้าซื้อครบ 500 ส่งฟรี', { topicKey: 'fee' }),
        fact('b', 'ถ้าไม่ครบ 500 ค่าส่ง 50 บาท', { topicKey: 'fee' }),
      ],
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.route).toBe('RAG');
    expect(result.selectedItems).toHaveLength(2);
  });

  it('คนละหัวข้อของสินค้าเดียวกัน (ราคา vs ค่าส่ง) ไม่ถือว่าขัดแย้ง', async () => {
    const { service } = makeService({
      micro: [
        fact('a', 'ราคา 500 บาท', { topicKey: 'price' }),
        fact('b', 'ราคา 800 บาท', { topicKey: 'shipping' }),
      ],
    });

    expect((await service.retrieve('ราคาเท่าไร')).route).toBe('RAG');
  });

  it('คนละสินค้า แม้ตัวเลขต่างกัน ก็ไม่ใช่ข้อมูลขัดแย้ง', async () => {
    const { service } = makeService({
      micro: [
        makeItem({
          id: 'a',
          source: 'MICRO_KNOWLEDGE',
          title: 'รุ่น A',
          answer: 'ราคา 500 บาท',
          metadata: { rawScore: 5, entityKey: 'model-a', topicKey: 'price' },
        }),
        makeItem({
          id: 'b',
          source: 'MICRO_KNOWLEDGE',
          title: 'รุ่น B',
          answer: 'ราคา 800 บาท',
          metadata: { rawScore: 5, entityKey: 'model-b', topicKey: 'price' },
        }),
      ],
    });

    expect((await service.retrieve('ราคาเท่าไร')).route).toBe('RAG');
  });
});

describe('KnowledgeRetrievalService — เมื่อแหล่งข้อมูลล้ม', () => {
  it('ช่องทางใดล้มก็ห้ามตอบจากข้อมูลที่เหลือ เพราะข้อยกเว้นอาจอยู่ในช่องที่หายไป', async () => {
    // ฐาน: ทุกช่องทางทำงานปกติ ตอบได้
    const { service } = makeService({
      database: [makeItem({ id: 'ok', metadata: { rawScore: 9 } })],
    });
    expect((await service.retrieve('ค่าส่งเท่าไร')).route).toBe('RAG');

    // ช่อง vector ล้ม ทั้งที่ช่องคำค้นยังมีของดีอยู่
    const { service: failing, semanticSearch } = makeService({
      database: [makeItem({ id: 'ok', metadata: { rawScore: 9 } })],
    });
    semanticSearch.mockRejectedValue(new Error('vector db down'));

    const result = await failing.retrieve('ค่าส่งเท่าไร');

    expect(result.route).toBe('LOW_CONFIDENCE');
    expect(result.fallbackReason).toBe('RETRIEVAL_ERROR');
    expect(result.selectedItems).toEqual([]);
    expect(result.items).toHaveLength(1); // ยังรายงานว่าเจออะไรไว้ให้ดู
  });

  it('cache ล้มแต่ DB อ่านได้ ถือว่ากู้คืนแล้ว ตอบต่อได้ตามปกติ', async () => {
    const { service, cacheMatches } = makeService({
      database: [makeItem({ id: 'ok', metadata: { rawScore: 9 } })],
    });
    cacheMatches.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    const result = await service.retrieve('ค่าส่งเท่าไร');

    expect(result.route).toBe('RAG');
    expect(result.selectedItems.map((item) => item.id)).toEqual(['ok']);
  });

  it('ค่าใช้จ่าย AI ที่ยังค้างสถานะ ต้องโยนต่อ ห้ามกลืนเป็น fallback', async () => {
    const { service, semanticSearch } = makeService();
    semanticSearch.mockRejectedValue(new PendingAiUsageError());

    await expect(service.retrieve('ค่าส่งเท่าไร')).rejects.toBeInstanceOf(
      PendingAiUsageError,
    );
  });
});

describe('KnowledgeRetrievalService — ต่อกับตัวจับคู่จริง', () => {
  it('แถวจากฐานข้อมูลจริงที่ตรงคำถามเป๊ะ ไหลไปถึงทางลัดตอบตรงได้', async () => {
    const rows = [
      makePattern({
        id: 'faq-real',
        title: '',
        questionExamples: ['ส่งฟรีไหม'],
        answer: 'ส่งฟรีทุกออเดอร์',
      }),
    ];
    const matcher = new AnswerPatternService(
      {
        answerPattern: { findMany: jest.fn().mockResolvedValue(rows) },
      } as unknown as PrismaService,
      configStub(),
    );
    const service = new KnowledgeRetrievalService(
      matcher,
      { getAll: () => [] } as unknown as AnswerPatternCacheService,
      {
        search: jest.fn().mockResolvedValue([]),
      } as unknown as SemanticSearchService,
      {
        findMatches: jest.fn().mockResolvedValue([]),
      } as unknown as MicroKnowledgeService,
      configStub(),
    );

    const result = await service.retrieve('ส่งฟรีไหม');

    expect(result.route).toBe('DIRECT');
    expect(result.matchType).toBe('EXACT');
    expect(result.selectedItems[0].answer).toBe('ส่งฟรีทุกออเดอร์');
  });
});
