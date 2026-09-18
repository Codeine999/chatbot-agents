import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { KnowledgeScope } from '../../chatbot/knowledge/knowledge-scope';

/**
 * Every raw SQL touch of `answerPatternVector` in one place.
 *
 * The column is `Unsupported("vector(1536)")`, so Prisma's query builder
 * cannot read or write it and each call site would otherwise hand-roll its
 * own `::vector` cast. Sharing them matters beyond tidiness: the health check
 * is only meaningful if it ranks candidates with the *same* query the chatbot
 * runs, and the indexer is only trustworthy if the writes it makes are the
 * ones retrieval expects to read.
 */
@Injectable()
export class AnswerPatternVectorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Postgres literal for a pgvector value. */
  static toVectorLiteral(values: readonly number[]): string {
    return `[${values.join(',')}]`;
  }

  async upsert(
    db: Prisma.TransactionClient | PrismaService,
    answerPatternId: string,
    values: readonly number[],
    model: string,
    active: boolean,
  ): Promise<void> {
    const vectorLiteral = AnswerPatternVectorRepository.toVectorLiteral(values);

    await db.$executeRaw(Prisma.sql`
      INSERT INTO "answerPatternVector" (
        "answerPatternId",
        "embedding",
        "embeddingModel",
        "active"
      )
      VALUES (
        ${answerPatternId}::uuid,
        ${vectorLiteral}::vector,
        ${model},
        ${active}
      )
      ON CONFLICT ("answerPatternId")
      DO UPDATE SET
        "embedding" = EXCLUDED."embedding",
        "embeddingModel" = EXCLUDED."embeddingModel",
        "active" = EXCLUDED."active",
        "updatedAt" = CURRENT_TIMESTAMP
    `);
  }

  search(
    values: readonly number[],
    model: string,
    limit: number,
    scope?: KnowledgeScope,
  ): Promise<SemanticSearchRow[]> {
    const vectorLiteral = AnswerPatternVectorRepository.toVectorLiteral(values);

    return this.prisma.$queryRaw<SemanticSearchRow[]>(Prisma.sql`
      SELECT
        pattern."id",
        pattern."title",
        pattern."description",
        pattern."category",
        pattern."intentKey",
        pattern."answer",
        pattern."priority",
        pattern."renderMode"::text AS "renderMode",
        pattern."tenantId",
        pattern."language",
        pattern."questionExamples",
        (1 - (vector."embedding" <=> ${vectorLiteral}::vector))::float8 AS "score"
      FROM "answerPatternVector" AS vector
      INNER JOIN "answerPattern" AS pattern
        ON pattern."id" = vector."answerPatternId"
      WHERE pattern."active" = true
        AND vector."active" = true
        AND vector."embeddingModel" = ${model}
        ${scope ? Prisma.sql`AND pattern."tenantId" IS NOT DISTINCT FROM ${scope.tenantId}::uuid AND pattern."language" = ${scope.language}` : Prisma.empty}
      ORDER BY vector."embedding" <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `);
  }

  /**
   * Index state of every pattern, joined so patterns with no vector row at
   * all appear alongside those whose vector was written by another model.
   * Both are invisible to `search()` and both read as an empty result there.
   */
  coverage(): Promise<VectorCoverageRow[]> {
    return this.prisma.$queryRaw<VectorCoverageRow[]>(Prisma.sql`
      SELECT
        pattern."id",
        pattern."title",
        pattern."active"          AS "patternActive",
        pattern."updatedAt"       AS "patternUpdatedAt",
        vector."embeddingModel"   AS "embeddingModel",
        vector."active"           AS "vectorActive",
        vector."updatedAt"        AS "vectorUpdatedAt"
      FROM "answerPattern" AS pattern
      LEFT JOIN "answerPatternVector" AS vector
        ON vector."answerPatternId" = pattern."id"
      ORDER BY pattern."priority" DESC, pattern."updatedAt" DESC
    `);
  }
}

export type SemanticSearchRow = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  intentKey: string | null;
  answer: string;
  priority: number;
  score: number;
  renderMode: 'direct' | 'rewrite';
  tenantId: string | null;
  language: string;
  questionExamples: string[];
};

export type VectorCoverageRow = {
  id: string;
  title: string;
  patternActive: boolean;
  patternUpdatedAt: Date;
  embeddingModel: string | null;
  vectorActive: boolean | null;
  vectorUpdatedAt: Date | null;
};
