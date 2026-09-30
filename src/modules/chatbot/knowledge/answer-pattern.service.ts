import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AnswerPattern } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { KnowledgeItem } from '../types/chat.types';
import {
  logBlock,
  logSafeText,
  normalizeText,
} from '../../../utils/text.utils';
import { MAX_RETRIEVAL_CANDIDATES } from '../constants/knowledge-routing.constants';
import {
  inKnowledgeScope,
  knowledgeScope,
  KnowledgeScope,
} from './knowledge-scope';
import { bm25Scores } from './thai-bm25';
import { isUsableKnowledge } from './knowledge-answer.policy';

const MAX_PATTERNS_SCANNED = 500;

export type AnswerPatternRetrievalLayer = 'CACHE' | 'DATABASE';
export type KnowledgeRecord = Omit<AnswerPattern, 'renderMode'> & {
  renderMode?: 'DIRECT' | 'REWRITE';
  entityKey?: string | null;
  topicKey?: string | null;
};
const BROAD_DIRECT_QUERIES = new Set([
  'ราคา',
  'สินค้า',
  'บริการ',
  'price',
  'pricing',
  'product',
  'products',
]);

@Injectable()
export class AnswerPatternService {
  private readonly logger = new Logger(AnswerPatternService.name);

  private readonly scope: KnowledgeScope;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.scope = knowledgeScope(config);
  }

  async findMatches(message: string): Promise<KnowledgeItem[]> {
    const normalized = normalizeText(message);
    if (!normalized) return [];

    const patterns = await this.prisma.answerPattern.findMany({
      where: { active: true, ...this.scope },
      take: MAX_PATTERNS_SCANNED,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });

    return this.findMatchesFromPatterns(message, patterns, 'DATABASE');
  }

  findMatchesFromPatterns(
    message: string,
    patterns: readonly KnowledgeRecord[],
    retrievalLayer: AnswerPatternRetrievalLayer = 'CACHE',
    source: KnowledgeItem['source'] = 'ANSWER_PATTERN',
  ): KnowledgeItem[] {
    const normalized = normalizeText(message);
    if (!normalized) return [];

    const eligible = patterns.filter(
      (pattern) =>
        inKnowledgeScope(pattern, this.scope) &&
        pattern.answer.trim() &&
        isUsableKnowledge({
          title: pattern.title,
          content: pattern.description ?? '',
          answer: pattern.answer,
        }),
    );
    const scores = bm25Scores(normalized, eligible);
    const scored = eligible
      .map((pattern, index) => ({
        pattern,
        score: scores[index],
        exact: this.isExactMatch(pattern, normalized),
      }))
      .filter(({ score, exact }) => exact || score > 0)
      .sort((a, b) => {
        if (a.exact !== b.exact) return Number(b.exact) - Number(a.exact);

        // Exact records are curated answers for the whole normalized query.
        // Prefer their priority and keep the original DB/cache order when it
        // ties. Non-exact candidates continue to use relevance then priority.
        if (a.exact) return b.pattern.priority - a.pattern.priority;

        return b.score - a.score || b.pattern.priority - a.pattern.priority;
      });

    // Check the complete scoped exact set before the candidate limit hides a
    // competing preset. A capped 500-row snapshot cannot prove uniqueness.
    const ambiguousExact =
      source === 'ANSWER_PATTERN' &&
      new Set(
        scored
          .filter((item) => item.exact)
          .map((item) => normalizeText(item.pattern.answer)),
      ).size > 1;

    this.logger.debug(
      logBlock(`Knowledge:${source}:${retrievalLayer}`, [
        `query=${JSON.stringify(logSafeText(normalized))}`,
        `scanned=${patterns.length}`,
        `matches=${scored.length}`,
        scored.length ? `top=${JSON.stringify(scored[0].pattern.title)}` : null,
        scored.length ? `score=${scored[0].score}` : null,
      ]),
    );

    return scored
      .slice(0, MAX_RETRIEVAL_CANDIDATES)
      .map(({ pattern, score, exact }) => {
        const item = this.toKnowledgeItem(
          pattern,
          score,
          exact,
          retrievalLayer,
          source,
        );
        return {
          ...item,
          metadata: {
            ...item.metadata,
            safeDirect:
              item.metadata?.safeDirect === true &&
              patterns.length < MAX_PATTERNS_SCANNED &&
              !ambiguousExact,
            ambiguousExact: exact && ambiguousExact,
          },
        };
      });
  }

  private isExactMatch(pattern: KnowledgeRecord, normalized: string): boolean {
    return (
      !BROAD_DIRECT_QUERIES.has(normalized) &&
      pattern.questionExamples.some(
        (value) => normalizeText(value) === normalized,
      )
    );
  }

  private toKnowledgeItem(
    pattern: KnowledgeRecord,
    score: number,
    exactMatch: boolean,
    retrievalLayer: AnswerPatternRetrievalLayer,
    source: KnowledgeItem['source'],
  ): KnowledgeItem {
    return {
      source,
      id: pattern.id,
      title: pattern.title,
      category: pattern.category,
      content: pattern.description ?? pattern.title,
      answer: pattern.answer,
      score,
      renderMode: pattern.renderMode,
      metadata: {
        tenantId: pattern.tenantId,
        language: pattern.language,
        active: pattern.active,
        entityKey: pattern.entityKey,
        topicKey: pattern.topicKey,
        questionExamples: pattern.questionExamples,
        priority: pattern.priority,
        intentKey: pattern.intentKey,
        rawScore: score,
        exactMatch,
        safeDirect: source === 'ANSWER_PATTERN' && exactMatch,
        matchTypes: [exactMatch ? 'EXACT' : 'KEYWORD'],
        retrievalLayer,
      },
    };
  }
}
