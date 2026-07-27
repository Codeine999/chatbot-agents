import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding.service';
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
    private readonly configService: ConfigService,
  ) {}

  async search(input: string, userId?: string): Promise<KnowledgeItem[]> {
    const embedding = await this.embeddingService.embedQuery(input, userId);
    const vectorLiteral = `[${embedding.values.join(',')}]`;
    const configuredFloor = Number(
      this.configService.get<string>('AI_VECTOR_MIN_SIMILARITY') ?? 0.6,
    );
    const similarityFloor = Number.isFinite(configuredFloor)
      ? Math.min(Math.max(configuredFloor, 0), 1)
      : 0.6;

    // this.logger.debug(
    //   `[SemanticSearch] input="${input}" dimension=${embedding.values.length}`,
    // );

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
        AND (1 - (vector."embedding" <=> ${vectorLiteral}::vector)) >= ${similarityFloor}
      ORDER BY vector."embedding" <=> ${vectorLiteral}::vector
      LIMIT 5
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
      },
    }));
  }
}
