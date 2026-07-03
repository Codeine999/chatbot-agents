import { Injectable } from '@nestjs/common';
import { KnowledgeItem } from './types/chat.types';

@Injectable()
export class SemanticSearchService {
  // TODO: implement vector search (pgvector or external embedding store)
  async search(_message: string): Promise<KnowledgeItem[]> {
    return [];
  }
}
