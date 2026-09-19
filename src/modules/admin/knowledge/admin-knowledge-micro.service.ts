import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroKnowledge } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { buildMicroKnowledgeDocument } from '../../ai/embeding/micro-knowledge-document';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import { MicroKnowledgeVectorRepository } from '../../ai/embeding/micro-knowledge-vector.repository';
import {
  knowledgeScope,
  KnowledgeScope,
} from '../../chatbot/knowledge/knowledge-scope';
import {
  CreateAdminMicroKnowledgeDto,
  UpdateAdminMicroKnowledgeDto,
} from './dto/admin-micro-knowledge.dto';

@Injectable()
export class AdminKnowledgeMicroService {
  private readonly scope: KnowledgeScope;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectors: MicroKnowledgeVectorRepository,
    config: ConfigService,
  ) {
    this.scope = knowledgeScope(config);
  }

  list(): Promise<MicroKnowledge[]> {
    return this.prisma.microKnowledge.findMany({
      where: { tenantId: this.scope.tenantId },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async count(): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.prisma.microKnowledge.count({
        where: { tenantId: this.scope.tenantId },
      }),
      this.prisma.microKnowledge.count({
        where: { tenantId: this.scope.tenantId, active: true },
      }),
    ]);

    return { total, active };
  }

  async create(
    input: CreateAdminMicroKnowledgeDto,
    adminMemberId?: string,
  ): Promise<MicroKnowledge> {
    const embedding = await this.embeddingService.embedDocument(
      buildMicroKnowledgeDocument(input),
      { adminMemberId },
    );

    return this.prisma.$transaction(async (tx) => {
      const knowledge = await tx.microKnowledge.create({
        data: { ...input, tenantId: this.scope.tenantId },
      });
      await this.vectors.upsert(
        tx,
        knowledge.id,
        embedding.values,
        embedding.model,
        knowledge.active,
      );
      return knowledge;
    });
  }

  async update(
    id: string,
    input: UpdateAdminMicroKnowledgeDto,
    adminMemberId?: string,
  ): Promise<MicroKnowledge> {
    const existing = await this.prisma.microKnowledge.findFirst({
      where: { id, tenantId: this.scope.tenantId },
    });

    if (!existing) {
      throw new NotFoundException('Micro knowledge not found');
    }

    const { addKeywords, removeKeywords, ...updates } = input;
    const keywords =
      addKeywords !== undefined || removeKeywords !== undefined
        ? this.patchKeywords(existing.keywords, addKeywords, removeKeywords)
        : updates.keywords;
    const data = {
      ...updates,
      ...(keywords !== undefined ? { keywords } : {}),
    };
    const merged = { ...existing, ...data };
    const embedding = await this.embeddingService.embedDocument(
      buildMicroKnowledgeDocument(merged),
      { adminMemberId },
    );

    return this.prisma.$transaction(async (tx) => {
      const knowledge = await tx.microKnowledge.update({
        where: { id },
        data,
      });
      await this.vectors.upsert(
        tx,
        knowledge.id,
        embedding.values,
        embedding.model,
        knowledge.active,
      );
      return knowledge;
    });
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const result = await this.prisma.microKnowledge.deleteMany({
      where: { id, tenantId: this.scope.tenantId },
    });

    if (!result.count) {
      throw new NotFoundException('Micro knowledge not found');
    }

    return { deleted: true };
  }

  async reindex(adminMemberId?: string): Promise<{
    indexed: number;
    failed: Array<{ id: string; reason: string }>;
  }> {
    const rows = await this.prisma.microKnowledge.findMany({
      where: { tenantId: this.scope.tenantId },
    });
    const failed: Array<{ id: string; reason: string }> = [];
    let indexed = 0;

    for (const knowledge of rows) {
      try {
        const embedding = await this.embeddingService.embedDocument(
          buildMicroKnowledgeDocument(knowledge),
          { adminMemberId },
        );
        await this.vectors.upsert(
          this.prisma,
          knowledge.id,
          embedding.values,
          embedding.model,
          knowledge.active,
        );
        indexed += 1;
      } catch (error) {
        failed.push({ id: knowledge.id, reason: String(error) });
      }
    }

    return { indexed, failed };
  }

  private patchKeywords(
    current: string[],
    addKeywords: string[] | undefined,
    removeKeywords: string[] | undefined,
  ): string[] {
    const normalize = (value: string) => value.trim().toLocaleLowerCase();
    const remove = new Set((removeKeywords ?? []).map(normalize));
    const keywords = current.filter(
      (keyword) => !remove.has(normalize(keyword)),
    );
    const seen = new Set(keywords.map(normalize));

    for (const keyword of addKeywords ?? []) {
      const normalized = normalize(keyword);
      if (!seen.has(normalized)) {
        keywords.push(keyword);
        seen.add(normalized);
      }
    }

    if (keywords.length > 100) {
      throw new BadRequestException('Keywords cannot exceed 100 values');
    }

    return keywords;
  }
}
