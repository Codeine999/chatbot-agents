import { Injectable } from '@nestjs/common';
import { AdminKnowledgeMicroService } from '../../knowledge/admin-knowledge-micro.service';
import { AdminKnowledgePatternService } from '../../knowledge/admin-knowledge-pattern.service';
import {
  CreateAdminAnswerPatternDto,
  UpdateAdminAnswerPatternDto,
} from '../../knowledge/dto/admin-answer-pattern.dto';
import {
  CreateAdminMicroKnowledgeDto,
  UpdateAdminMicroKnowledgeDto,
} from '../../knowledge/dto/admin-micro-knowledge.dto';

export type BulkCreateResult<T> = {
  created: T[];
  failed: Array<{ index: number; title: string; reason: string }>;
};

/**
 * Dev-only bulk entry point. It delegates to the existing admin services so
 * validation scope, embedding, vector upsert and cache refresh stay identical
 * to the single-item endpoints.
 */
@Injectable()
export class KnowledgeAnswerService {
  constructor(
    private readonly patterns: AdminKnowledgePatternService,
    private readonly micro: AdminKnowledgeMicroService,
  ) {}

  createPatterns(items: CreateAdminAnswerPatternDto[], adminMemberId?: string) {
    return this.createEach(items, (item) =>
      this.patterns.create(item, adminMemberId),
    );
  }

  updatePattern(
    id: string,
    body: UpdateAdminAnswerPatternDto,
    adminMemberId?: string,
  ) {
    return this.patterns.update(id, body, adminMemberId);
  }

  createMicro(items: CreateAdminMicroKnowledgeDto[], adminMemberId?: string) {
    return this.createEach(items, (item) =>
      this.micro.create(item, adminMemberId),
    );
  }

  updateMicro(
    id: string,
    body: UpdateAdminMicroKnowledgeDto,
    adminMemberId?: string,
  ) {
    return this.micro.update(id, body, adminMemberId);
  }

  /**
   * Sequential on purpose: each item calls the embedding provider, and a failed
   * item must not roll back or block the items that already succeeded.
   */
  private async createEach<I extends { title: string }, T>(
    items: I[],
    create: (item: I) => Promise<T>,
  ): Promise<BulkCreateResult<T>> {
    const result: BulkCreateResult<T> = { created: [], failed: [] };

    for (const [index, item] of items.entries()) {
      try {
        result.created.push(await create(item));
      } catch (error) {
        result.failed.push({
          index,
          title: item.title,
          reason: error instanceof Error ? error.message : 'Create failed',
        });
      }
    }

    return result;
  }
}
