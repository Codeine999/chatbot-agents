import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeItem } from '../types/chat.types';
import { EmbeddingService } from './embedding.service';

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
  ) {}

  async search(input: string): Promise<KnowledgeItem[]> {
    const vector = await this.embeddingService.embed(input);

    this.logger.debug(
      `[SemanticSearch] input="${input}" dimension=${vector.length}`,
    );

    return [];
  }
}
