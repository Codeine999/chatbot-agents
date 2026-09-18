import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnswerPatternCacheService } from './answer-pattern-cache.service';

describe('AnswerPatternCacheService freshness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serves a fresh scoped snapshot and hides an expired one when refresh fails', async () => {
    const rows = [{ id: 'test' }];
    const prisma = {
      answerPattern: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const cache = new AnswerPatternCacheService(
      prisma as unknown as PrismaService,
      new ConfigService({}),
    );
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await cache.refresh();
    expect(cache.getAll()).toBe(rows);
    expect(prisma.answerPattern.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, tenantId: null, language: 'th' },
      }),
    );
    prisma.answerPattern.findMany.mockRejectedValue(
      new Error('database unavailable'),
    );
    jest.spyOn(Date, 'now').mockReturnValue(1_300_000);
    expect(cache.getAll()).toEqual([]);
    await cache.refresh();
    expect(cache.getAll()).toEqual([]);
    await cache.refresh();
  });
});
