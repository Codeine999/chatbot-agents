import { AnswerPatternService } from '../answer-pattern.service';
import { MicroKnowledgeService } from '../micro-knowledge.service';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { configStub, makePattern } from './knowledge.fixtures';

type FindManyArgs = { where?: unknown; take?: number; orderBy?: unknown };
type FindManyMock = jest.Mock<Promise<unknown[]>, [FindManyArgs]>;

const findManyMock = (rows: unknown[] = []): FindManyMock =>
  jest.fn<Promise<unknown[]>, [FindManyArgs]>().mockResolvedValue(rows);

const makeService = (findMany: FindManyMock, matcher: AnswerPatternService) =>
  new MicroKnowledgeService(
    { microKnowledge: { findMany } } as unknown as PrismaService,
    matcher,
    configStub(),
  );

describe('MicroKnowledgeService', () => {
  it('อ่านเฉพาะเกร็ดข้อมูลที่ active ใน scope เรียงตาม priority ไม่เกิน 500 แถว', async () => {
    const findMany = findManyMock();
    const matcher = {
      findMatchesFromPatterns: jest.fn().mockReturnValue([]),
    } as unknown as AnswerPatternService;

    await makeService(findMany, matcher).findMatches('ค่าส่ง');

    expect(findMany).toHaveBeenCalledWith({
      where: { active: true, tenantId: null, language: 'th' },
      take: 500,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  });

  it('ส่งต่อให้ตัวจับคู่เดียวกับ answerPattern โดยติดป้ายว่ามาจาก MICRO_KNOWLEDGE', async () => {
    const rows = [makePattern({ id: 'fact-1' })];
    const findMany = findManyMock(rows);
    const findMatchesFromPatterns = jest.fn().mockReturnValue([]);
    const matcher = {
      findMatchesFromPatterns,
    } as unknown as AnswerPatternService;

    await makeService(findMany, matcher).findMatches('ค่าส่ง');

    expect(findMatchesFromPatterns).toHaveBeenCalledWith(
      'ค่าส่ง',
      rows,
      'DATABASE',
      'MICRO_KNOWLEDGE',
    );
  });

  it('ผลลัพธ์จริงติด source MICRO_KNOWLEDGE และไม่มีสิทธิ์ตอบตรง', async () => {
    const findMany = findManyMock([
      makePattern({
        id: 'fact-1',
        title: '',
        questionExamples: ['ค่าส่งเท่าไร'],
        answer: 'ค่าส่ง 50 บาท',
      }),
    ]);
    const matcher = new AnswerPatternService(
      {} as unknown as PrismaService,
      configStub(),
    );

    const [item] = await makeService(findMany, matcher).findMatches(
      'ค่าส่งเท่าไร',
    );

    expect(item.source).toBe('MICRO_KNOWLEDGE');
    expect(item.answer).toBe('ค่าส่ง 50 บาท');
    expect(item.metadata?.safeDirect).toBe(false);
    expect(item.metadata?.retrievalLayer).toBe('DATABASE');
  });
});
