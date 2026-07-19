import { Injectable, Logger } from '@nestjs/common';
import {
  AnswerPatternCacheEntry,
  AnswerPatternCacheService,
} from './answer-pattern-cache.service';
import { normalizeText } from '../../../utils/text.utils';

export type KnowledgeCandidateResult = {
  matched: boolean;
  /** Whole normalized message equals a question example or keyword. */
  exact: boolean;
  confidence: number;
  score: number;
  reason: string;
  patternId?: string;
  title?: string;
};

/**
 * Same signal hierarchy as AnswerPatternService.findMatches, restricted to
 * the lightweight cached fields (no description/answer scoring).
 */
const WEIGHT = {
  KEYWORD_FULL_MESSAGE: 5,
  KEYWORD_TOKEN_EXACT: 4,
  KEYWORD_CONTAINS: 3,
  EXAMPLE_EXACT: 5,
  EXAMPLE_CONTAINS: 2.5,
  EXAMPLE_TOKEN_OVERLAP: 2,
  INTENT_KEY: 2,
  TITLE: 1,
  CATEGORY: 1,
  KEYWORD_MULTI_BONUS: 0.5,
} as const;

/**
 * Route to ANSWER_KNOWLEDGE only on a strong signal (contained keyword or
 * near-exact example). Weak/ambiguous messages still go to the AI classifier,
 * and answerKnowledge itself has DB + vector + fallback if the match is wrong.
 */
const MATCH_THRESHOLD = 3;
const MIN_CONTAINS_LENGTH = 2;

@Injectable()
export class KnowledgeCandidateService {
  private readonly logger = new Logger(KnowledgeCandidateService.name);

  constructor(private readonly cache: AnswerPatternCacheService) {}

  /**
   * Decide whether a message likely targets a knowledge-base item.
   * Pure in-memory pre-router check — it never produces the final answer.
   */
  detect(input: string): KnowledgeCandidateResult {
    const normalized = normalizeText(input);
    if (!normalized) {
      return this.noMatch(0, 'empty input');
    }

    const tokens = this.tokenize(normalized);
    const patterns = this.cache.getAll();
    if (patterns.length === 0) {
      return this.noMatch(0, 'answer pattern cache empty');
    }

    let best: { entry: AnswerPatternCacheEntry; score: number } | null = null;
    for (const entry of patterns) {
      const score = this.scoreEntry(entry, normalized, tokens);
      if (score > (best?.score ?? 0)) {
        best = { entry, score };
      }
    }

    if (!best || best.score < MATCH_THRESHOLD) {
      return this.noMatch(
        best?.score ?? 0,
        `no knowledge candidate above threshold ${MATCH_THRESHOLD}`,
      );
    }

    const confidence = Math.min(0.95, 0.65 + best.score * 0.04);
    this.logger.debug(
      `[KnowledgeCandidate] "${normalized}" matched "${best.entry.title}" ` +
        `score=${best.score} confidence=${confidence.toFixed(2)}`,
    );

    return {
      matched: true,
      exact: this.isExactMatch(best.entry, normalized),
      confidence,
      score: best.score,
      reason: `knowledge candidate "${best.entry.title}" matched (score=${best.score})`,
      patternId: best.entry.id,
      title: best.entry.title,
    };
  }

  private noMatch(score: number, reason: string): KnowledgeCandidateResult {
    return { matched: false, exact: false, confidence: 0, score, reason };
  }

  /**
   * Whole-message equality with a question example or keyword. Unlike a
   * composed partial score, such a match is unambiguous even when the user
   * is mid-conversation, so the router may trust it without an AI rewrite.
   */
  private isExactMatch(
    entry: AnswerPatternCacheEntry,
    normalized: string,
  ): boolean {
    return (
      entry.questionExamples.some((raw) => normalizeText(raw) === normalized) ||
      entry.keywords.some((raw) => normalizeText(raw) === normalized)
    );
  }

  private scoreEntry(
    entry: AnswerPatternCacheEntry,
    normalized: string,
    tokens: string[],
  ): number {
    let score = 0;

    score += this.scoreKeywords(entry.keywords, normalized, tokens);
    score += this.scoreQuestionExamples(
      entry.questionExamples,
      normalized,
      tokens,
    );

    const intentKey = normalizeText(entry.intentKey ?? '');
    if (
      intentKey &&
      (tokens.includes(intentKey) || this.contains(normalized, intentKey))
    ) {
      score += WEIGHT.INTENT_KEY;
    }

    const title = normalizeText(entry.title);
    if (title && this.contains(normalized, title)) {
      score += WEIGHT.TITLE;
    }

    const category = normalizeText(entry.category ?? '');
    if (category && this.contains(normalized, category)) {
      score += WEIGHT.CATEGORY;
    }

    return score;
  }

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

  private tokenize(normalized: string): string[] {
    return normalized.split(' ').filter((token) => token.length > 1);
  }

  private contains(haystack: string, needle: string): boolean {
    return needle.length >= MIN_CONTAINS_LENGTH && haystack.includes(needle);
  }

  private tokenOverlapRatio(source: string[], target: string[]): number {
    if (source.length === 0 || target.length === 0) return 0;
    const targetSet = new Set(target);
    const hits = source.filter((token) => targetSet.has(token)).length;
    return hits / source.length;
  }
}
