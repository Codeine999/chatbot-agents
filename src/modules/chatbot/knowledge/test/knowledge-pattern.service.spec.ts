import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../../prisma/prisma.service';

import {
  AnswerPatternService,
  KnowledgeRecord,
} from '../answer-pattern.service';

describe('AnswerPatternService', () => {
  let service: AnswerPatternService;

  const prisma = {
    answerPattern: {
      findMany: jest.fn(),
    },
  };

  const config = {
    get: jest.fn(),
  };

  const makePattern = (
    overrides: Partial<KnowledgeRecord> = {},
  ): KnowledgeRecord => {
    return {
      id: 'pattern-1',
      tenantId: null,
      title: '',
      description: null,
      category: null,
      intentKey: null,
      keywords: [],
      questionExamples: [],
      answer: 'answer',
      language: 'th',
      priority: 0,
      active: true,
      renderMode: 'DIRECT',

      ...overrides,
    } as KnowledgeRecord;
  };

  beforeEach(() => {
    service = new AnswerPatternService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('gives a positive BM25 score for an exact keyword term', () => {
    const patterns = [
      makePattern({
        keywords: ['ราคา'],
      }),
    ];

    const result = service.findMatchesFromPatterns('ราคา', patterns);

    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThan(0);
  });
});
