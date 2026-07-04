import { Injectable } from '@nestjs/common';
import { AnswerPatternService } from './answer-pattern.service';
import { SemanticSearchService } from './semantic-search.service';
import { KnowledgeItem } from '../types/chat.types';

const STRONG_KEYWORD_SCORE = 3;

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly answerPatternService: AnswerPatternService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {}

  async retrieve(message: string): Promise<KnowledgeItem[]> {
    const patterns = await this.answerPatternService.findMatches(message);

    // ถ้า keyword เจอชัด ไม่ต้องยิง embedding
    if (patterns[0]?.score >= STRONG_KEYWORD_SCORE) {
      return patterns;
    }

    try {
      const semantic = await this.semanticSearchService.search(message);

      return [...patterns, ...semantic]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    } catch {
      return patterns;
    }
  }
}
