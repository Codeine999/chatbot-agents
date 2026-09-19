import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import { MicroKnowledgeVectorRepository } from '../../ai/embeding/micro-knowledge-vector.repository';
import { AdminKnowledgeMicroService } from './admin-knowledge-micro.service';
import { CreateAdminMicroKnowledgeDto } from './dto/admin-micro-knowledge.dto';

const embedding = {
  values: [0.1, 0.2, 0.3],
  model: 'gemini-embedding-2',
  usage: {
    inputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  },
  usageEstimated: true,
};

const input = {
  title: 'เงื่อนไขการคืนสินค้า',
  description: 'สินค้าต้องอยู่ในสภาพสมบูรณ์',
  category: 'after-sales',
  intentKey: 'refund_policy',
  entityKey: 'pillow-cloud',
  topicKey: 'returns',
  keywords: ['คืนสินค้า', 'คืนเงิน'],
  questionExamples: ['คืนสินค้าได้ไหม'],
  answer: 'คืนสินค้าได้ภายใน 7 วันหลังได้รับสินค้า',
  language: 'th',
  priority: 80,
  active: true,
} as unknown as CreateAdminMicroKnowledgeDto;

function build() {
  const created = { ...input, id: 'f1' };
  const tx = {
    microKnowledge: {
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue(created),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    microKnowledge: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(created),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn((callback: (db: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const embeddingService = {
    embedDocument: jest.fn().mockResolvedValue(embedding),
  } as unknown as jest.Mocked<EmbeddingService>;
  const vectors = new MicroKnowledgeVectorRepository(
    prisma as unknown as PrismaService,
  );

  return {
    service: new AdminKnowledgeMicroService(
      prisma as unknown as PrismaService,
      embeddingService,
      vectors,
      { get: jest.fn() } as unknown as ConfigService,
    ),
    prisma,
    tx,
    embeddingService,
    created,
  };
}

describe('AdminKnowledgeMicroService.create', () => {
  it('embeds every MicroKnowledge retrieval field before opening the transaction', async () => {
    const ctx = build();

    await ctx.service.create(input);

    const document = ctx.embeddingService.embedDocument.mock.calls[0][0];
    expect(document).toContain('หัวข้อ: เงื่อนไขการคืนสินค้า');
    expect(document).toContain('สิ่งที่อ้างถึง: pillow-cloud');
    expect(document).toContain('ประเด็น: returns');
    expect(document).toContain('คำสำคัญ: คืนสินค้า, คืนเงิน');
    expect(document).toContain(
      'ข้อเท็จจริง: คืนสินค้าได้ภายใน 7 วันหลังได้รับสินค้า',
    );
    expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ctx.tx.microKnowledge.create).toHaveBeenCalledWith({
      data: { ...input, tenantId: null },
    });
  });

  it('upserts the vector by microKnowledgeId', async () => {
    const ctx = build();

    await ctx.service.create(input);

    const firstCall = ctx.tx.$executeRaw.mock.calls[0] as [unknown];
    const sql = firstCall[0] as { strings: string[] };
    expect(sql.strings.join(' ')).toContain('ON CONFLICT ("microKnowledgeId")');
  });
});

describe('AdminKnowledgeMicroService.update', () => {
  it('re-embeds the merged row including entity and topic keys', async () => {
    const ctx = build();

    await ctx.service.update('f1', { answer: 'แก้ไขแล้ว' });

    const document = ctx.embeddingService.embedDocument.mock.calls[0][0];
    expect(document).toContain('สิ่งที่อ้างถึง: pillow-cloud');
    expect(document).toContain('ประเด็น: returns');
    expect(document).toContain('ข้อเท็จจริง: แก้ไขแล้ว');
  });

  it('does not spend an embedding for an unknown row', async () => {
    const ctx = build();
    ctx.prisma.microKnowledge.findFirst.mockResolvedValue(null);

    await expect(
      ctx.service.update('missing', { title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.embeddingService.embedDocument.mock.calls).toHaveLength(0);
  });
});

describe('AdminKnowledgeMicroService', () => {
  it('reports total and active counts', async () => {
    const ctx = build();
    ctx.prisma.microKnowledge.count.mockResolvedValueOnce(10);
    ctx.prisma.microKnowledge.count.mockResolvedValueOnce(7);

    await expect(ctx.service.count()).resolves.toEqual({
      total: 10,
      active: 7,
    });
    expect(ctx.prisma.microKnowledge.count).toHaveBeenNthCalledWith(1, {
      where: { tenantId: null },
    });
    expect(ctx.prisma.microKnowledge.count).toHaveBeenNthCalledWith(2, {
      where: { tenantId: null, active: true },
    });
  });

  it('removes the row and relies on the vector cascade', async () => {
    const ctx = build();

    await expect(ctx.service.remove('f1')).resolves.toEqual({ deleted: true });
    expect(ctx.prisma.microKnowledge.deleteMany).toHaveBeenCalledWith({
      where: { id: 'f1', tenantId: null },
    });
  });

  it('continues reindexing after one embedding failure', async () => {
    const ctx = build();
    ctx.prisma.microKnowledge.findMany.mockResolvedValue([
      { ...ctx.created, id: 'a' },
      { ...ctx.created, id: 'b' },
    ]);
    ctx.embeddingService.embedDocument
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(embedding);

    const result = await ctx.service.reindex();

    expect(ctx.prisma.microKnowledge.findMany).toHaveBeenCalledWith({
      where: { tenantId: null },
    });
    expect(result.indexed).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: 'a' });
    expect(result.failed[0]?.reason).toContain('rate limited');
  });
});
