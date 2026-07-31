import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding.service';
import { SemanticSearchService } from './semantic-search.service';

type RawSql = { strings: string[]; values: unknown[] };

const embedding = { values: [0.1, 0.2, 0.3], model: 'gemini-embedding-2' };

function build(env: Record<string, string | undefined> = {}) {
  const embeddingService = {
    embedQuery: jest.fn().mockResolvedValue(embedding),
  } as unknown as jest.Mocked<EmbeddingService>;
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;

  const service = new SemanticSearchService(
    embeddingService,
    prisma as unknown as PrismaService,
    configService,
  );
  const sql = () => prisma.$queryRaw.mock.calls[0][0] as RawSql;

  return { service, embeddingService, prisma, sql };
}

describe('SemanticSearchService', () => {
  it('embeds the input as a query, not a document', async () => {
    const { service, embeddingService } = build();

    await service.search('ราคาเท่าไหร่', 'U1');

    expect(embeddingService.embedQuery).toHaveBeenCalledWith('ราคาเท่าไหร่', 'U1');
  });

  it('serialises the vector into pgvector literal form', async () => {
    const { service, sql } = build();

    await service.search('ราคา');

    expect(sql().values).toContain('[0.1,0.2,0.3]');
  });

  it('binds the embedding model so mismatched vectors are excluded', async () => {
    const { service, sql } = build();

    await service.search('ราคา');

    expect(sql().values).toContain('gemini-embedding-2');
  });

  it('filters on active pattern AND active vector and orders by distance', async () => {
    const { service, sql } = build();

    await service.search('ราคา');
    const text = sql().strings.join(' ');

    expect(text).toContain('pattern."active" = true');
    expect(text).toContain('vector."active" = true');
    expect(text).toContain('ORDER BY');
    expect(text).toContain('LIMIT 5');
  });

  describe('similarity floor', () => {
    it('defaults to 0.6 when unconfigured', async () => {
      const { service, sql } = build();

      await service.search('ราคา');

      expect(sql().values).toContain(0.6);
    });

    it('uses AI_VECTOR_MIN_SIMILARITY when set', async () => {
      const { service, sql } = build({ AI_VECTOR_MIN_SIMILARITY: '0.78' });

      await service.search('ราคา');

      expect(sql().values).toContain(0.78);
    });

    it.each([
      ['1.4', 1],
      ['-0.5', 0],
    ])('clamps %s to %s', async (configured, expected) => {
      const { service, sql } = build({ AI_VECTOR_MIN_SIMILARITY: configured });

      await service.search('ราคา');

      expect(sql().values).toContain(expected);
    });

    it('falls back to 0.6 on a non-numeric value', async () => {
      const { service, sql } = build({ AI_VECTOR_MIN_SIMILARITY: 'high' });

      await service.search('ราคา');

      expect(sql().values).toContain(0.6);
    });

    /**
     * DEFECT: an empty string parses to 0 via Number(''), which is finite and
     * in range, so the floor silently becomes 0 and every vector matches.
     */
    it('DEFECT: an empty AI_VECTOR_MIN_SIMILARITY disables the floor entirely', async () => {
      const { service, sql } = build({ AI_VECTOR_MIN_SIMILARITY: '' });

      await service.search('ราคา');

      expect(sql().values).toContain(0);
    });
  });

  describe('row mapping', () => {
    const row = {
      id: 'p1',
      title: 'ราคาค่าบริการ',
      description: 'รายละเอียดราคา',
      category: 'pricing',
      intentKey: 'pricing',
      answer: 'เริ่มต้น 1,000 บาท',
      priority: 90,
      score: 0.78,
    };

    it('maps a row to a SEMANTIC_CHUNK knowledge item', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([row]);

      const [item] = await service.search('ราคา');

      expect(item).toEqual({
        source: 'SEMANTIC_CHUNK',
        id: 'p1',
        title: 'ราคาค่าบริการ',
        category: 'pricing',
        content: 'รายละเอียดราคา',
        answer: 'เริ่มต้น 1,000 บาท',
        score: 0.78,
        metadata: {
          priority: 90,
          intentKey: 'pricing',
          embeddingModel: 'gemini-embedding-2',
        },
      });
    });

    it('falls back to the title when description is null', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([{ ...row, description: null }]);

      const [item] = await service.search('ราคา');

      expect(item.content).toBe('ราคาค่าบริการ');
    });

    it('returns an empty list when nothing clears the floor', async () => {
      const { service } = build();

      await expect(service.search('อากาศดี')).resolves.toEqual([]);
    });
  });

  it('propagates embedding failures to the caller', async () => {
    const { service, embeddingService } = build();
    embeddingService.embedQuery.mockRejectedValue(new Error('budget exceeded'));

    await expect(service.search('ราคา')).rejects.toThrow('budget exceeded');
  });

  it('propagates database failures to the caller', async () => {
    const { service, prisma } = build();
    prisma.$queryRaw.mockRejectedValue(new Error('relation does not exist'));

    await expect(service.search('ราคา')).rejects.toThrow(
      'relation does not exist',
    );
  });

  /**
   * DEFECT (measured against the live corpus with gemini-embedding-2 @1536d):
   * off-topic greetings score up to ~0.67 and true matches bottom out at
   * ~0.67-0.69. A 0.6 floor therefore admits pure small talk, so
   * AiChatService.answerFromEmbedding grounds the model on an unrelated
   * pattern instead of returning the configured fallback.
   */
  it('DEFECT: the default 0.6 floor does not separate off-topic from on-topic', async () => {
    const { service, prisma, sql } = build();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'p1',
        title: 'ราคาค่าบริการ',
        description: null,
        category: 'pricing',
        intentKey: 'pricing',
        answer: 'เริ่มต้น 1,000 บาท',
        priority: 90,
        score: 0.654, // observed top score for the query "สวัสดีครับ"
      },
    ]);

    const items = await service.search('สวัสดีครับ');

    expect(sql().values).toContain(0.6);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('ราคาค่าบริการ');
  });
});
