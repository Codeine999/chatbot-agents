import { Injectable, Logger } from '@nestjs/common';
import { AnswerPatternVectorRepository } from '../../ai/embeding/answer-pattern-vector.repository';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import type { EmbeddingUsageContext } from '../../ai/embeding/embedding.service';
import { MAX_RETRIEVAL_CANDIDATES } from '../constants/knowledge-routing.constants';
import { KnowledgeItem } from '../types/chat.types';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectors: AnswerPatternVectorRepository,
  ) {}

  async search(
    input: string,
    context: EmbeddingUsageContext = {},
  ): Promise<KnowledgeItem[]> {
    const embedding = await this.embeddingService.embedQuery(input, context);

    this.logger.debug(
      `[SemanticSearch] input="${input}" dimension=${embedding.values.length}`,
    );

    const rows = await this.vectors.search(
      embedding.values,
      embedding.model,
      MAX_RETRIEVAL_CANDIDATES,
    );

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
