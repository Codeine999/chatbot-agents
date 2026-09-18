import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnswerPatternVectorRepository } from '../../ai/embeding/answer-pattern-vector.repository';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import type { EmbeddingUsageContext } from '../../ai/embeding/embedding.service';
import { MAX_RETRIEVAL_CANDIDATES } from '../constants/knowledge-routing.constants';
import { KnowledgeItem } from '../types/chat.types';
import { MicroKnowledgeVectorRepository } from '../../ai/embeding/micro-knowledge-vector.repository';
import { knowledgeScope, KnowledgeScope } from './knowledge-scope';
import { logBlock, logSafeText } from '../../../utils/text.utils';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);
  private readonly scope: KnowledgeScope;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectors: AnswerPatternVectorRepository,
    private readonly microVectors: MicroKnowledgeVectorRepository,
    config: ConfigService,
  ) {
    this.scope = knowledgeScope(config);
  }

  async search(
    input: string,
    context: EmbeddingUsageContext = {},
  ): Promise<KnowledgeItem[]> {
    const embedding = await this.embeddingService.embedQuery(input, context);

    this.logger.debug(
      logBlock('SemanticSearch', [
        `query=${JSON.stringify(logSafeText(input))}`,
        `model=${embedding.model}`,
        `dimension=${embedding.values.length}`,
      ]),
    );

    const [patterns, facts] = await Promise.all([
      this.vectors.search(
        embedding.values,
        embedding.model,
        MAX_RETRIEVAL_CANDIDATES,
        this.scope,
      ),
      this.microVectors.search(
        embedding.values,
        embedding.model,
        MAX_RETRIEVAL_CANDIDATES,
        this.scope,
      ),
    ]);
    this.logger.debug(
      logBlock('SemanticSearch', [
        `patterns=${patterns.length}`,
        `facts=${facts.length}`,
        patterns[0]
          ? `topPattern=${Number(patterns[0].score).toFixed(4)}`
          : 'topPattern=-',
        facts[0] ? `topFact=${Number(facts[0].score).toFixed(4)}` : 'topFact=-',
      ]),
    );

    const rows = [
      ...patterns.map((row) => ({
        ...row,
        source: 'ANSWER_PATTERN' as const,
        renderMode:
          row.renderMode === 'rewrite'
            ? ('REWRITE' as const)
            : ('DIRECT' as const),
        entityKey: null,
        topicKey: null,
      })),
      ...facts.map((row) => ({
        ...row,
        source: 'MICRO_KNOWLEDGE' as const,
        renderMode: undefined,
      })),
    ];

    return rows.map((row) => ({
      source: row.source,
      id: row.id,
      title: row.title,
      category: row.category,
      content: row.description ?? row.title,
      answer: row.answer,
      score: Number(row.score),
      renderMode: row.renderMode,
      metadata: {
        tenantId: row.tenantId,
        language: row.language,
        active: true,
        entityKey: row.entityKey,
        topicKey: row.topicKey,
        questionExamples: row.questionExamples,
        vectorSimilarity: Number(row.score),
        priority: row.priority,
        intentKey: row.intentKey,
        embeddingModel: embedding.model,
        exactMatch: false,
        safeDirect: false,
        matchTypes: ['EMBEDDING'],
      },
    }));
  }
}
