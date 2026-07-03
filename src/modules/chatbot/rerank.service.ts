import { Injectable } from '@nestjs/common';
import { KnowledgeItem } from './types/chat.types';

@Injectable()
export class RerankService {
  mergeAndSort(items: KnowledgeItem[]): KnowledgeItem[] {
    const seen = new Set<string>();
    return items
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }
}
