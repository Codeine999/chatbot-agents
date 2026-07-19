import { Injectable, Logger } from '@nestjs/common';
import type { AnswerPattern } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { KnowledgeItem } from '../types/chat.types';
import { normalizeText } from '../../../utils/text.utils';

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
  /** Bonus at priority >= PRIORITY_CAP; scales linearly below that. */
  PRIORITY_MAX_BONUS: 0.5,
} as const;

const PRIORITY_CAP = 100;
/** Matches scoring below this are considered noise and dropped. */
const MIN_MATCH_SCORE = 2;
const MAX_MATCHES = 5;
const MAX_PATTERNS_SCANNED = 500;
/** Substrings shorter than this are too ambiguous for containment matching. */
const MIN_CONTAINS_LENGTH = 2;

@Injectable()
export class AnswerPatternService {
  private readonly logger = new Logger(AnswerPatternService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Direct DB search over answer_patterns — no embedding involved.
   * Scores every active pattern against the normalized message and returns
   * the strongest matches sorted by score desc, then priority desc.
   */
  async findMatches(message: string): Promise<KnowledgeItem[]> {
    const normalized = normalizeText(message);
    if (!normalized) return [];

    const tokens = this.tokenize(normalized);

    const patterns = await this.prisma.answerPattern.findMany({
      where: { active: true },
      take: MAX_PATTERNS_SCANNED,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });

    const scored = patterns
      .map((pattern) => ({
        pattern,
        score: this.scoreAnswerPattern(pattern, normalized, tokens),
      }))
      .filter(({ score }) => score >= MIN_MATCH_SCORE)
      .sort(
        (a, b) => b.score - a.score || b.pattern.priority - a.pattern.priority,
      )
      .slice(0, MAX_MATCHES);

    this.logger.debug(
      `[AnswerPattern] "${normalized}" -> ${scored.length} match(es)` +
        (scored.length
          ? ` top="${scored[0].pattern.title}" score=${scored[0].score}`
          : ''),
    );

    return scored.map(({ pattern, score }) =>
      this.toKnowledgeItem(pattern, score),
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
    pattern: AnswerPattern,
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

    // Priority only breaks ties between real matches; it never creates one.
    if (score > 0) {
      const priority = Math.min(Math.max(pattern.priority, 0), PRIORITY_CAP);
      score += (priority / PRIORITY_CAP) * WEIGHT.PRIORITY_MAX_BONUS;
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

  private toKnowledgeItem(pattern: AnswerPattern, score: number): KnowledgeItem {
    return {
      source: 'ANSWER_PATTERN',
      id: pattern.id,
      title: pattern.title,
      category: pattern.category,
      content: pattern.description ?? pattern.title,
      answer: pattern.answer,
      score,
      metadata: { priority: pattern.priority, intentKey: pattern.intentKey },
    };
  }
}
