import { Injectable } from '@nestjs/common';
import { AnswerPatternService } from './answer-pattern.service';
import { SemanticSearchService } from './semantic-search.service';
import { RerankService } from './rerank.service';
import { KnowledgeItem } from './types/chat.types';

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly answerPatternService: AnswerPatternService,
    private readonly semanticSearchService: SemanticSearchService,
    private readonly rerankService: RerankService,
  ) {}

  async retrieve(message: string): Promise<KnowledgeItem[]> {
    const [patterns, semantic] = await Promise.all([
      this.answerPatternService.findMatches(message),
      this.semanticSearchService.search(message),
    ]);
    return this.rerankService.mergeAndSort([...patterns, ...semantic]);
  }
}
