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

/**
 * Score weights for direct (non-embedding) answer_patterns matching.
 * Thai text has no word spacing, so substring containment is treated as a
 * strong signal alongside token equality (which covers spaced/English text).
 */
const WEIGHT = {
  /** Whole normalized message equals a keyword. */
  KEYWORD_FULL_MESSAGE: 5,
  /** A message token equals a keyword exactly. */
  KEYWORD_TOKEN_EXACT: 4,
  /** Message contains the keyword as a substring (main Thai match path). */
  KEYWORD_CONTAINS: 3,
  /** A keyword contains one of the message tokens (loose partial). */
  KEYWORD_PARTIAL: 1.5,
  /** Whole normalized message equals a question example. */
  EXAMPLE_EXACT: 5,
  /** Message contains the example or vice versa. */
  EXAMPLE_CONTAINS: 2.5,
  /** Max score from token overlap between message and example. */
  EXAMPLE_TOKEN_OVERLAP: 2,
  INTENT_KEY: 2,
  TITLE: 1,
  CATEGORY: 1,
  DESCRIPTION: 0.5,
  /** Extra per additional matched keyword beyond the first. */
  KEYWORD_MULTI_BONUS: 0.5,
} as const;

/** Matches scoring below this are considered noise and dropped. */
const MIN_MATCH_SCORE = 2;
const MAX_PATTERNS_SCANNED = 500;
/** Substrings shorter than this are too ambiguous for containment matching. */
const MIN_CONTAINS_LENGTH = 2;

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

  /**
   * Direct DB search over answer_patterns — no embedding involved.
   * Scores every active pattern against the normalized message and returns
   * the strongest matches sorted by score desc, then priority desc.
   */
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

  /**
   * Score an existing pattern snapshot with the exact same matcher as the DB
   * path. The cache calls this method so scoring weights cannot drift between
   * cache lookup and the authoritative database fallback.
   */
  findMatchesFromPatterns(
    message: string,
    patterns: readonly KnowledgeRecord[],
    retrievalLayer: AnswerPatternRetrievalLayer = 'CACHE',
    source: KnowledgeItem['source'] = 'ANSWER_PATTERN',
  ): KnowledgeItem[] {
    const normalized = normalizeText(message);
    if (!normalized) return [];

    const tokens = this.tokenize(normalized);

    const scored = patterns
      .filter(
        (pattern) =>
          inKnowledgeScope(pattern, this.scope) && pattern.answer.trim(),
      )
      .map((pattern) => ({
        pattern,
        score: this.scoreAnswerPattern(pattern, normalized, tokens),
        exact: this.isExactMatch(pattern, normalized),
      }))
      .filter(({ score }) => score >= MIN_MATCH_SCORE)
      .sort((a, b) => {
        if (a.exact !== b.exact) return Number(b.exact) - Number(a.exact);

        // Exact records are curated answers for the whole normalized query.
        // Prefer their priority and keep the original DB/cache order when it
        // ties. Non-exact candidates continue to use relevance then priority.
        if (a.exact) return b.pattern.priority - a.pattern.priority;

        return b.score - a.score || b.pattern.priority - a.pattern.priority;
      });

    // Check the complete scanned exact set before the candidate limit hides a
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

  /**
   * Whitespace tokens. Unspaced Thai text stays a single token and is
   * matched via substring containment instead.
   */
  private tokenize(normalized: string): string[] {
    return normalized.split(' ').filter((token) => token.length > 1);
  }

  private scoreAnswerPattern(
    pattern: KnowledgeRecord,
    normalized: string,
    tokens: string[],
  ): number {
    let score = 0;

    score += this.scoreKeywords(pattern.keywords, normalized, tokens);
    score += this.scoreQuestionExamples(
      pattern.questionExamples,
      normalized,
      tokens,
    );

    const intentKey = normalizeText(pattern.intentKey ?? '');

    if (
      intentKey &&
      (tokens.includes(intentKey) || this.contains(normalized, intentKey))
    ) {
      score += WEIGHT.INTENT_KEY;
    }

    const title = normalizeText(pattern.title);
    if (title && this.contains(normalized, title)) {
      score += WEIGHT.TITLE;
    }

    const category = normalizeText(pattern.category ?? '');
    if (category && this.contains(normalized, category)) {
      score += WEIGHT.CATEGORY;
    }

    const description = normalizeText(pattern.description ?? '');
    if (
      description &&
      (this.contains(description, normalized) ||
        tokens.some((token) => this.contains(description, token)))
    ) {
      score += WEIGHT.DESCRIPTION;
    }

    return score;
  }

  /** Best single-keyword score plus a small capped bonus for extra keyword hits. */
  private scoreKeywords(
    keywords: string[],
    normalized: string,
    tokens: string[],
  ): number {
    let best = 0;
    let matched = 0;

    for (const raw of keywords) {
      const keyword = normalizeText(raw);
      if (!keyword) continue;

      let current = 0;
      if (normalized === keyword) {
        current = WEIGHT.KEYWORD_FULL_MESSAGE;
      } else if (tokens.includes(keyword)) {
        current = WEIGHT.KEYWORD_TOKEN_EXACT;
      } else if (this.contains(normalized, keyword)) {
        current = WEIGHT.KEYWORD_CONTAINS;
      } else if (tokens.some((token) => this.contains(keyword, token))) {
        current = WEIGHT.KEYWORD_PARTIAL;
      }

      if (current > 0) {
        matched += 1;
        best = Math.max(best, current);
      }
    }

    const multiBonus = Math.min(
      Math.max(matched - 1, 0) * WEIGHT.KEYWORD_MULTI_BONUS,
      1,
    );
    return best + multiBonus;
  }

  /** Best similarity score across the pattern's question examples. */
  private scoreQuestionExamples(
    examples: string[],
    normalized: string,
    tokens: string[],
  ): number {
    let best = 0;

    for (const raw of examples) {
      const example = normalizeText(raw);
      if (!example) continue;

      if (example === normalized) {
        best = Math.max(best, WEIGHT.EXAMPLE_EXACT);
        continue;
      }

      if (
        this.contains(normalized, example) ||
        this.contains(example, normalized)
      ) {
        best = Math.max(best, WEIGHT.EXAMPLE_CONTAINS);
        continue;
      }

      const overlap = this.tokenOverlapRatio(tokens, this.tokenize(example));
      if (overlap >= 0.5) {
        best = Math.max(best, WEIGHT.EXAMPLE_TOKEN_OVERLAP * overlap);
      }
    }

    return best;
  }

  /** Substring containment guarded against overly short, ambiguous needles. */
  private contains(haystack: string, needle: string): boolean {
    return needle.length >= MIN_CONTAINS_LENGTH && haystack.includes(needle);
  }

  /** Fraction of source tokens that also appear in target. */
  private tokenOverlapRatio(source: string[], target: string[]): number {
    if (source.length === 0 || target.length === 0) return 0;
    const targetSet = new Set(target);
    const hits = source.filter((token) => targetSet.has(token)).length;
    return hits / source.length;
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
