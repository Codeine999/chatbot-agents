import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AnswerPatternService,
  type KnowledgeRecord,
} from './answer-pattern.service';
import { knowledgeScope, KnowledgeScope } from './utils/knowledge-scope';
import { KnowledgeItem } from '../shared/types/chat.types';

@Injectable()
export class MicroKnowledgeService {
  private readonly scope: KnowledgeScope;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: AnswerPatternService,
    config: ConfigService,
  ) {
    this.scope = knowledgeScope(config);
  }

  /** `snapshot` (the in-memory rows) skips the database read. */
  async findMatches(
    query: string,
    snapshot?: readonly KnowledgeRecord[],
  ): Promise<KnowledgeItem[]> {
    const rows =
      snapshot ??
      (await this.prisma.microKnowledge.findMany({
        where: { active: true, ...this.scope },
        take: 500,
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      }));
    return this.matcher.findMatchesFromPatterns(
      query,
      rows,
      snapshot ? 'CACHE' : 'DATABASE',
      'MICRO_KNOWLEDGE',
    );
  }
}
