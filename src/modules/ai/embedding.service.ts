import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EMBEDDING_ADAPTER } from '../../infra/embedding/embedding-adapter.interface';
import type {
  EmbeddingAdapter,
  EmbeddingResult,
} from '../../infra/embedding/embedding-adapter.interface';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(EMBEDDING_ADAPTER)
    private readonly adapter: EmbeddingAdapter,
    private readonly aiBudgetService: AiBudgetService,
  ) {}

  embedQuery(text: string, userId?: string): Promise<EmbeddingResult> {
    return this.embed(text, 'RETRIEVAL_QUERY', userId);
  }

  embedDocument(text: string): Promise<EmbeddingResult> {
    return this.embed(text, 'RETRIEVAL_DOCUMENT');
  }

  private async embed(
    text: string,
    task: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT',
    userId?: string,
  ): Promise<EmbeddingResult> {
    const normalized = text.trim();

    if (!normalized) {
      throw new ServiceUnavailableException('Cannot embed empty text');
    }

    if (!(await this.aiBudgetService.tryConsume(userId))) {
      throw new ServiceUnavailableException('AI embedding budget exceeded');
    }

    return this.adapter.embed({ text: normalized, task });
  }
}
