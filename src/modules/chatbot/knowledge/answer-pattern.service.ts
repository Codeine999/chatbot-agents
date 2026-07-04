import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { KnowledgeItem } from '../types/chat.types';

@Injectable()
export class AnswerPatternService {
  constructor(private readonly prisma: PrismaService) {}

  async findMatches(message: string): Promise<KnowledgeItem[]> {
    const normalized = message.toLowerCase().trim();
    const words = normalized.split(/\s+/);

    const patterns = await this.prisma.answerPattern.findMany({
      where: { active: true },
      take: 200,
      orderBy: { priority: 'desc' },
    });

    return patterns
      .map((p) => {
        let score = 0;

        if (p.keywords.some((k) => words.includes(k.toLowerCase()) || normalized.includes(k.toLowerCase()))) score += 3;
        if (p.questionExamples.some((q) => normalized.includes(q.toLowerCase()))) score += 2;
        if (p.intentKey && normalized.includes(p.intentKey.toLowerCase())) score += 2;
        if (normalized.includes(p.title.toLowerCase())) score += 1;
        if (p.category && normalized.includes(p.category.toLowerCase())) score += 1;
        if (p.priority > 50) score += 0.5;

        return { p, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.p.priority - a.p.priority)
      .slice(0, 5)
      .map(({ p, score }) => ({
        source: 'ANSWER_PATTERN' as const,
        id: p.id,
        title: p.title,
        category: p.category,
        content: p.description ?? p.title,
        answer: p.answer,
        score,
        metadata: { priority: p.priority },
      }));
  }
}
