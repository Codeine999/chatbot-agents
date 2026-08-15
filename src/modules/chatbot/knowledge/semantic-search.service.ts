import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding.service';
import { MAX_RETRIEVAL_CANDIDATES } from '../constants/knowledge-routing.constants';
import { KnowledgeItem } from '../types/chat.types';

type SemanticSearchRow = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  intentKey: string | null;
  answer: string;
  priority: number;
  score: number;
};

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly prisma: PrismaService,
  ) {}

  async search(input: string, userId?: string): Promise<KnowledgeItem[]> {
    const embedding = await this.embeddingService.embedQuery(input, userId);
    const vectorLiteral = `[${embedding.values.join(',')}]`;

    this.logger.debug(
      `[SemanticSearch] input="${input}" dimension=${embedding.values.length}`,
    );

    const rows = await this.prisma.$queryRaw<SemanticSearchRow[]>(Prisma.sql`
      SELECT
        pattern."id",
        pattern."title",
        pattern."description",
        pattern."category",
        pattern."intentKey",
        pattern."answer",
        pattern."priority",
        (1 - (vector."embedding" <=> ${vectorLiteral}::vector))::float8 AS "score"
      FROM "AnswerPatternVector" AS vector
      INNER JOIN "AnswerPattern" AS pattern
        ON pattern."id" = vector."answerPatternId"
      WHERE pattern."active" = true
        AND vector."active" = true
        AND vector."embeddingModel" = ${embedding.model}
      ORDER BY vector."embedding" <=> ${vectorLiteral}::vector
      LIMIT ${MAX_RETRIEVAL_CANDIDATES}
    `);

    return rows.map((row) => ({
      source: 'SEMANTIC_CHUNK',
      id: row.id,
      title: row.title,
      category: row.category,
      content: row.description ?? row.title,
      answer: row.answer,
      score: Number(row.score),
      metadata: {
        priority: row.priority,
        intentKey: row.intentKey,
        embeddingModel: embedding.model,
        exactMatch: false,
        matchTypes: ['EMBEDDING'],
      },
    }));
  }
}
