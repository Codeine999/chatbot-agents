import { Injectable, NotFoundException } from '@nestjs/common';
import { AnswerPattern, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmbeddingService } from '../../ai/embedding.service';
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
  ) {}

  list(): Promise<AnswerPattern[]> {
    return this.prisma.answerPattern.findMany({
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async create(input: CreateAdminAnswerPatternDto): Promise<AnswerPattern> {
    const embedding = await this.embeddingService.embedDocument(
      this.embeddingDocument(input),
    );

    const pattern = await this.prisma.$transaction(async (tx) => {
      const pattern = await tx.answerPattern.create({ data: input });
      await this.upsertVector(
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
  ): Promise<AnswerPattern> {
    const existing = await this.prisma.answerPattern.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Answer pattern not found');
    }

    const merged = { ...existing, ...input };
    const embedding = await this.embeddingService.embedDocument(
      this.embeddingDocument(merged),
    );

    const pattern = await this.prisma.$transaction(async (tx) => {
      const pattern = await tx.answerPattern.update({
        where: { id },
        data: input,
      });
      await this.upsertVector(
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

  async reindex(): Promise<{
    indexed: number;
    failed: Array<{ id: string; reason: string }>;
  }> {
    const patterns = await this.prisma.answerPattern.findMany();
    const failed: Array<{ id: string; reason: string }> = [];
    let indexed = 0;

    for (const pattern of patterns) {
      try {
        const embedding = await this.embeddingService.embedDocument(
          this.embeddingDocument(pattern),
        );
        await this.upsertVector(
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

  private embeddingDocument(input: {
    title: string;
    description?: string | null;
    category?: string | null;
    intentKey?: string | null;
    keywords: string[];
    questionExamples: string[];
    answer: string;
  }): string {
    return [
      `หัวข้อ: ${input.title}`,
      input.description ? `รายละเอียด: ${input.description}` : null,
      input.category ? `หมวดหมู่: ${input.category}` : null,
      input.intentKey ? `เจตนา: ${input.intentKey}` : null,
      input.keywords.length ? `คำสำคัญ: ${input.keywords.join(', ')}` : null,
      input.questionExamples.length
        ? `ตัวอย่างคำถาม:\n${input.questionExamples.join('\n')}`
        : null,
      `คำตอบ: ${input.answer}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async upsertVector(
    db: Prisma.TransactionClient | PrismaService,
    answerPatternId: string,
    values: readonly number[],
    model: string,
    active: boolean,
  ): Promise<void> {
    const vectorLiteral = `[${values.join(',')}]`;

    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnswerPatternVector" (
        "answerPatternId",
        "embedding",
        "embeddingModel",
        "active"
      )
      VALUES (
        ${answerPatternId}::uuid,
        ${vectorLiteral}::vector,
        ${model},
        ${active}
      )
      ON CONFLICT ("answerPatternId")
      DO UPDATE SET
        "embedding" = EXCLUDED."embedding",
        "embeddingModel" = EXCLUDED."embeddingModel",
        "active" = EXCLUDED."active",
        "updatedAt" = CURRENT_TIMESTAMP
    `);
  }
}
