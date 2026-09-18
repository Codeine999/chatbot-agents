import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnswerPatternService } from './answer-pattern.service';
import { knowledgeScope, KnowledgeScope } from './knowledge-scope';
import { KnowledgeItem } from '../types/chat.types';

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

  async findMatches(query: string): Promise<KnowledgeItem[]> {
    const rows = await this.prisma.microKnowledge.findMany({
      where: { active: true, ...this.scope },
      take: 500,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
    return this.matcher.findMatchesFromPatterns(
      query,
      rows,
      'DATABASE',
      'MICRO_KNOWLEDGE',
    );
  }
}
