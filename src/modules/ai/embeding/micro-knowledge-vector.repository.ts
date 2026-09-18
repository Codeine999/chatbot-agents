import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { KnowledgeScope } from '../../chatbot/knowledge/knowledge-scope';
import {
  AnswerPatternVectorRepository,
  SemanticSearchRow,
} from './answer-pattern-vector.repository';

@Injectable()
export class MicroKnowledgeVectorRepository {
  constructor(private readonly prisma: PrismaService) {}

  search(
    values: readonly number[],
    model: string,
    limit: number,
    scope: KnowledgeScope,
  ): Promise<MicroKnowledgeSearchRow[]> {
    const literal = AnswerPatternVectorRepository.toVectorLiteral(values);
    return this.prisma.$queryRaw<MicroKnowledgeSearchRow[]>(Prisma.sql`
      SELECT fact."id", fact."title", fact."description", fact."category",
        fact."intentKey", fact."entityKey", fact."topicKey", fact."answer",
        fact."priority", fact."tenantId", fact."language", fact."questionExamples",
        (1 - (vector."embedding" <=> ${literal}::vector))::float8 AS "score"
      FROM "microKnowledgeVector" AS vector
      INNER JOIN "microKnowledge" AS fact ON fact."id" = vector."microKnowledgeId"
      WHERE fact."active" = true AND vector."active" = true
        AND vector."embeddingModel" = ${model}
        AND fact."tenantId" IS NOT DISTINCT FROM ${scope.tenantId}::uuid
        AND fact."language" = ${scope.language}
      ORDER BY vector."embedding" <=> ${literal}::vector
      LIMIT ${limit}
    `);
  }
}

export type MicroKnowledgeSearchRow = Omit<SemanticSearchRow, 'renderMode'> & {
  entityKey: string | null;
  topicKey: string | null;
};
