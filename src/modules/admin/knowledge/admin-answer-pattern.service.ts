import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AnswerPattern } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import { AnswerPatternVectorRepository } from '../../ai/embeding/answer-pattern-vector.repository';
import { buildAnswerPatternDocument } from '../../ai/embeding/answer-pattern-document';
import { AnswerPatternCacheService } from '../../chatbot/knowledge/answer-pattern-cache.service';
import {
  CreateAdminAnswerPatternDto,
  UpdateAdminAnswerPatternDto,
} from './dto/admin-answer-pattern.dto';

@Injectable()
export class AdminAnswerPatternService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly answerPatternCache: AnswerPatternCacheService,
    private readonly vectors: AnswerPatternVectorRepository,
  ) {}

  list(): Promise<AnswerPattern[]> {
    return this.prisma.answerPattern.findMany({
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async count(): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.prisma.answerPattern.count(),
      this.prisma.answerPattern.count({ where: { active: true } }),
    ]);

    return { total, active };
  }

  async create(
    input: CreateAdminAnswerPatternDto,
    adminMemberId?: string,
  ): Promise<AnswerPattern> {
    const embedding = await this.embeddingService.embedDocument(
      buildAnswerPatternDocument(input),
      { adminMemberId },
    );

    const pattern = await this.prisma.$transaction(async (tx) => {
      const pattern = await tx.answerPattern.create({ data: input });
      await this.vectors.upsert(
        tx,
        pattern.id,
        embedding.values,
        embedding.model,
        pattern.active,
      );
      return pattern;
    });

    await this.answerPatternCache.refresh();
    return pattern;
  }

  async update(
    id: string,
    input: UpdateAdminAnswerPatternDto,
    adminMemberId?: string,
  ): Promise<AnswerPattern> {
    const existing = await this.prisma.answerPattern.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Answer pattern not found');
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
      buildAnswerPatternDocument(merged),
      { adminMemberId },
    );

    const pattern = await this.prisma.$transaction(async (tx) => {
      const pattern = await tx.answerPattern.update({
        where: { id },
        data,
      });
      await this.vectors.upsert(
        tx,
        pattern.id,
        embedding.values,
        embedding.model,
        pattern.active,
      );
      return pattern;
    });

    await this.answerPatternCache.refresh();
    return pattern;
  }

  async remove(id: string): Promise<{ deleted: true }> {
    const result = await this.prisma.answerPattern.deleteMany({
      where: { id },
    });

    if (!result.count) {
      throw new NotFoundException('Answer pattern not found');
    }

    await this.answerPatternCache.refresh();
    return { deleted: true };
  }

  async reindex(adminMemberId?: string): Promise<{
    indexed: number;
    failed: Array<{ id: string; reason: string }>;
  }> {
    const patterns = await this.prisma.answerPattern.findMany();
    const failed: Array<{ id: string; reason: string }> = [];
    let indexed = 0;

    for (const pattern of patterns) {
      try {
        const embedding = await this.embeddingService.embedDocument(
          buildAnswerPatternDocument(pattern),
          { adminMemberId },
        );
        await this.vectors.upsert(
          this.prisma,
          pattern.id,
          embedding.values,
          embedding.model,
          pattern.active,
        );
        indexed += 1;
      } catch (error) {
        failed.push({ id: pattern.id, reason: String(error) });
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
