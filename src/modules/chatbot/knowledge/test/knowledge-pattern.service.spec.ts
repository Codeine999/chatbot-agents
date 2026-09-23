import { describe, it, expect, beforeEach, jest } from '@jest/globals';

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
    service = new AnswerPatternService(prisma as any, config as any);
  });

  it('should give full-message keyword score of 5', () => {
    const patterns = [
      makePattern({
        keywords: ['ราคา'],
      }),
    ];

    const result = service.findMatchesFromPatterns('ราคา', patterns);

    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(5);
  });
});
