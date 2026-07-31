import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding.service';
import { AnswerPatternCacheService } from '../../chatbot/knowledge/answer-pattern-cache.service';
import { AdminAnswerPatternService } from './admin-answer-pattern.service';
import { CreateAdminAnswerPatternDto } from './dto/admin-answer-pattern.dto';

const embedding = { values: [0.1, 0.2, 0.3], model: 'gemini-embedding-2' };

const input = {
  title: 'ราคาค่าบริการ',
  description: 'รายละเอียดราคา',
  category: 'pricing',
  intentKey: 'pricing',
  keywords: ['ราคา', 'ค่าบริการ'],
  questionExamples: ['ค่าบริการเท่าไร', 'ราคาเท่าไหร่'],
  answer: 'เริ่มต้น 1,000 บาท',
  language: 'th',
  priority: 90,
  active: true,
} as unknown as CreateAdminAnswerPatternDto;

function build() {
  const created = { ...input, id: 'p1' };
  const tx = {
    answerPattern: {
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue(created),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    answerPattern: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(created),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const embeddingService = {
    embedDocument: jest.fn().mockResolvedValue(embedding),
  } as unknown as jest.Mocked<EmbeddingService>;
  const cache = {
    refresh: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AnswerPatternCacheService>;

  return {
    service: new AdminAnswerPatternService(
      prisma as unknown as PrismaService,
      embeddingService,
      cache,
    ),
    prisma,
    tx,
    embeddingService,
    cache,
    created,
  };
}

describe('AdminAnswerPatternService.create', () => {
  it('builds the indexed document from every question-side field plus the answer', async () => {
    const ctx = build();

    await ctx.service.create(input);
    const doc = ctx.embeddingService.embedDocument.mock.calls[0][0];

    expect(doc).toContain('หัวข้อ: ราคาค่าบริการ');
    expect(doc).toContain('รายละเอียด: รายละเอียดราคา');
    expect(doc).toContain('หมวดหมู่: pricing');
    expect(doc).toContain('เจตนา: pricing');
    expect(doc).toContain('คำสำคัญ: ราคา, ค่าบริการ');
    expect(doc).toContain('ตัวอย่างคำถาม:');
    expect(doc).toContain('คำตอบ: เริ่มต้น 1,000 บาท');
  });

  it('omits empty optional fields from the document', async () => {
    const ctx = build();

    await ctx.service.create({
      ...input,
      description: null,
      category: null,
      intentKey: null,
      keywords: [],
      questionExamples: [],
    } as unknown as CreateAdminAnswerPatternDto);
    const doc = ctx.embeddingService.embedDocument.mock.calls[0][0];

    expect(doc).not.toContain('รายละเอียด:');
    expect(doc).not.toContain('คำสำคัญ:');
    expect(doc).toBe('หัวข้อ: ราคาค่าบริการ\nคำตอบ: เริ่มต้น 1,000 บาท');
  });

  it('embeds before opening the transaction so a failure writes nothing', async () => {
    const ctx = build();
    ctx.embeddingService.embedDocument.mockRejectedValue(new Error('502'));

    await expect(ctx.service.create(input)).rejects.toThrow('502');
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    expect(ctx.cache.refresh).not.toHaveBeenCalled();
  });

  it('writes the row and its vector inside one transaction', async () => {
    const ctx = build();

    await ctx.service.create(input);

    expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ctx.tx.answerPattern.create).toHaveBeenCalledWith({ data: input });
    expect(ctx.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('binds the pgvector literal, model and active flag on upsert', async () => {
    const ctx = build();

    await ctx.service.create(input);
    const sql = ctx.tx.$executeRaw.mock.calls[0][0] as { values: unknown[] };

    expect(sql.values).toEqual(
      expect.arrayContaining(['p1', '[0.1,0.2,0.3]', 'gemini-embedding-2', true]),
    );
  });

  it('upserts on answerPatternId so re-indexing never duplicates a vector', async () => {
    const ctx = build();

    await ctx.service.create(input);
    const sql = ctx.tx.$executeRaw.mock.calls[0][0] as { strings: string[] };

    expect(sql.strings.join(' ')).toContain('ON CONFLICT ("answerPatternId")');
  });

  it('refreshes the in-memory router cache after committing', async () => {
    const ctx = build();

    await ctx.service.create(input);

    expect(ctx.cache.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('AdminAnswerPatternService.update', () => {
  it('re-embeds the merged row, not just the patch', async () => {
    const ctx = build();

    await ctx.service.update('p1', { title: 'ราคาใหม่' });
    const doc = ctx.embeddingService.embedDocument.mock.calls[0][0];

    expect(doc).toContain('หัวข้อ: ราคาใหม่');
    // untouched fields still contribute to the vector
    expect(doc).toContain('คำสำคัญ: ราคา, ค่าบริการ');
  });

  it('rejects an unknown id before spending an embedding call', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.findUnique.mockResolvedValue(null);

    await expect(ctx.service.update('missing', { title: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(ctx.embeddingService.embedDocument).not.toHaveBeenCalled();
  });
});

describe('AdminAnswerPatternService.remove', () => {
  it('rejects an unknown id', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.deleteMany.mockResolvedValue({ count: 0 });

    await expect(ctx.service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deletes the row and refreshes the cache (the vector cascades)', async () => {
    const ctx = build();

    await expect(ctx.service.remove('p1')).resolves.toEqual({ deleted: true });
    expect(ctx.cache.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('AdminAnswerPatternService.reindex', () => {
  it('re-embeds every pattern, including inactive ones', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.findMany.mockResolvedValue([
      { ...ctx.created, id: 'a' },
      { ...ctx.created, id: 'b', active: false },
    ]);

    const result = await ctx.service.reindex();

    expect(ctx.prisma.answerPattern.findMany).toHaveBeenCalledWith();
    expect(result).toEqual({ indexed: 2, failed: [] });
    expect(ctx.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-pattern failure and keeps going', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.findMany.mockResolvedValue([
      { ...ctx.created, id: 'a' },
      { ...ctx.created, id: 'b' },
    ]);
    ctx.embeddingService.embedDocument
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(embedding);

    const result = await ctx.service.reindex();

    expect(result.indexed).toBe(1);
    expect(result.failed).toEqual([
      { id: 'a', reason: expect.stringContaining('rate limited') },
    ]);
  });

  /**
   * DEFECT: reindex does not refresh AnswerPatternCacheService, so the router's
   * in-memory keyword cache can stay stale for up to the 240s TTL afterwards.
   */
  it('DEFECT: reindex leaves the router cache stale', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.findMany.mockResolvedValue([ctx.created]);

    await ctx.service.reindex();

    expect(ctx.cache.refresh).not.toHaveBeenCalled();
  });

  /**
   * DEFECT: reindex is the only way to backfill vectors for rows created before
   * the vector table existed, yet nothing calls it automatically and it is not
   * idempotent-safe against partial failure reporting per row - a caller that
   * ignores `failed` believes the index is complete. In the live database 15 of
   * 16 patterns currently have no vector row at all.
   */
  it('DEFECT: partial failures still return a success-shaped result', async () => {
    const ctx = build();
    ctx.prisma.answerPattern.findMany.mockResolvedValue([
      { ...ctx.created, id: 'a' },
      { ...ctx.created, id: 'b' },
    ]);
    ctx.embeddingService.embedDocument.mockRejectedValue(new Error('down'));

    const result = await ctx.service.reindex();

    expect(result.indexed).toBe(0);
    expect(result.failed).toHaveLength(2);
  });
});
