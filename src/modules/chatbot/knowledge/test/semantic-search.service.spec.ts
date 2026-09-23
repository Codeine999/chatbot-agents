import { SemanticSearchService } from '../semantic-search.service';
import type { AnswerPatternVectorRepository } from '../../../ai/embeding/answer-pattern-vector.repository';
import type { MicroKnowledgeVectorRepository } from '../../../ai/embeding/micro-knowledge-vector.repository';
import type { EmbeddingService } from '../../../ai/embeding/embedding.service';
import { configStub } from './knowledge.fixtures';

const embedding = { values: [0.1, 0.2], model: 'text-embedding-004' };

const patternRow = {
  id: 'pattern-1',
  title: 'ค่าส่ง',
  description: 'อธิบายค่าส่ง',
  category: 'shipping',
  intentKey: 'shipping_fee',
  answer: 'ค่าส่ง 50 บาท',
  priority: 3,
  score: 0.82,
  renderMode: 'direct' as const,
  tenantId: null,
  language: 'th',
  questionExamples: ['ค่าส่งเท่าไร'],
};

const factRow = {
  id: 'fact-1',
  title: 'ค่าส่งกรุงเทพ',
  description: null,
  category: null,
  intentKey: null,
  entityKey: 'shipping',
  topicKey: 'fee',
  answer: 'ในกรุงเทพส่งฟรี',
  priority: 1,
  score: 0.71,
  tenantId: null,
  language: 'th',
  questionExamples: [],
};

const makeService = (
  overrides: {
    embed?: jest.Mock;
    patterns?: jest.Mock;
    facts?: jest.Mock;
    env?: Record<string, string>;
  } = {},
) => {
  const embed = overrides.embed ?? jest.fn().mockResolvedValue(embedding);
  const patterns = overrides.patterns ?? jest.fn().mockResolvedValue([]);
  const facts = overrides.facts ?? jest.fn().mockResolvedValue([]);

  return {
    embed,
    patterns,
    facts,
    service: new SemanticSearchService(
      { embedQuery: embed } as unknown as EmbeddingService,
      { search: patterns } as unknown as AnswerPatternVectorRepository,
      { search: facts } as unknown as MicroKnowledgeVectorRepository,
      configStub(overrides.env),
    ),
  };
};

describe('SemanticSearchService', () => {
  it('ฝังคำค้นครั้งเดียวแล้วใช้ผลเดียวกันค้นทั้งสองคลัง พร้อมส่ง scope ไปกรองที่ SQL', async () => {
    const tenantId = 'dcfee647-fc7f-450e-ba99-a968bfd29601';
    const { service, embed, patterns, facts } = makeService({
      env: { KNOWLEDGE_TENANT_ID: tenantId, KNOWLEDGE_LANGUAGE: 'en' },
    });
    const context = { userId: 'U1' };

    await service.search('shipping fee', context);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith('shipping fee', context);
    const expected = [
      embedding.values,
      embedding.model,
      20,
      { tenantId, language: 'en' },
    ];
    expect(patterns).toHaveBeenCalledWith(...expected);
    expect(facts).toHaveBeenCalledWith(...expected);
  });

  it('แปลงแถว answerPattern เป็น KnowledgeItem พร้อมคะแนน vector', async () => {
    const { service } = makeService({
      patterns: jest.fn().mockResolvedValue([patternRow]),
    });

    const [item] = await service.search('ค่าส่งเท่าไร');

    expect(item).toMatchObject({
      source: 'ANSWER_PATTERN',
      id: 'pattern-1',
      content: 'อธิบายค่าส่ง',
      answer: 'ค่าส่ง 50 บาท',
      score: 0.82,
      renderMode: 'DIRECT',
    });
    expect(item.metadata).toMatchObject({
      vectorSimilarity: 0.82,
      embeddingModel: embedding.model,
      active: true,
      exactMatch: false,
      safeDirect: false,
      matchTypes: ['EMBEDDING'],
      priority: 3,
    });
  });

  it('แถวที่ตั้งค่าให้เรียบเรียงใหม่ ต้องกลายเป็น REWRITE ไม่ใช่ตอบตรง', async () => {
    const { service } = makeService({
      patterns: jest
        .fn()
        .mockResolvedValue([{ ...patternRow, renderMode: 'rewrite' as const }]),
    });

    const [item] = await service.search('ค่าส่งเท่าไร');

    expect(item.renderMode).toBe('REWRITE');
    expect(item.metadata?.safeDirect).toBe(false);
  });

  it('แถว MicroKnowledge พก entityKey/topicKey มาให้ตัวตรวจข้อมูลขัดแย้งใช้ต่อ', async () => {
    const { service } = makeService({
      facts: jest.fn().mockResolvedValue([factRow]),
    });

    const [item] = await service.search('ค่าส่งกรุงเทพ');

    expect(item.source).toBe('MICRO_KNOWLEDGE');
    expect(item.renderMode).toBeUndefined();
    expect(item.content).toBe('ค่าส่งกรุงเทพ'); // description ว่าง ใช้ title แทน
    expect(item.metadata).toMatchObject({
      entityKey: 'shipping',
      topicKey: 'fee',
    });
  });

  it('ฝังคำค้นไม่สำเร็จ ต้องโยนต่อ ไม่กลืนเป็นผลลัพธ์ว่าง', async () => {
    const { service, patterns, facts } = makeService({
      embed: jest.fn().mockRejectedValue(new Error('provider down')),
    });

    await expect(service.search('ค่าส่ง')).rejects.toThrow('provider down');
    expect(patterns).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
  });
});
