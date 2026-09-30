import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import {
  logBlock,
  logSafeText,
  normalizeText,
  redactPii,
} from '../../../utils/text.utils';
import {
  MAX_RAG_CONTEXTS,
  MAX_RETRIEVAL_CANDIDATES,
  RRF_RANK_CONSTANT,
  DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY,
  DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE,
  MAX_RAG_EVIDENCE_CHARACTERS,
} from '../constants/knowledge-routing.constants';
import {
  ChatContextMessage,
  KnowledgeItem,
  KnowledgeMatchType,
  KnowledgeRetrievalResult,
} from '../types/chat.types';
import { AnswerPatternCacheService } from './answer-pattern-cache.service';
import { AnswerPatternService } from './answer-pattern.service';
import { MicroKnowledgeService } from './micro-knowledge.service';
import { SemanticSearchService } from './semantic-search.service';
import { resolveRetrievalQuery } from './retrieval-query-planner.service';
import { knowledgeScope, KnowledgeScope } from './knowledge-scope';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';
import { isUsableKnowledge } from './knowledge-answer.policy';

/** Enough rows to explain the winner without burying the flow. */
const MAX_LOGGED_CANDIDATES = 5;

type RetrievalContext = LineAiUsageContext &
  Readonly<{ recentMessages?: readonly ChatContextMessage[] }>;

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);
  private readonly scope: KnowledgeScope;
  private readonly vectorNoiseFloor: number;
  private readonly lexicalNoiseFloor: number;

  constructor(
    private readonly patterns: AnswerPatternService,
    private readonly cache: AnswerPatternCacheService,
    private readonly semantic: SemanticSearchService,
    private readonly micro: MicroKnowledgeService,
    config: ConfigService,
  ) {
    this.scope = knowledgeScope(config);
    // Candidate/noise thresholds only. Never compare these against RRF scores.
    this.vectorNoiseFloor = z.coerce
      .number()
      .min(-1)
      .max(1)
      .parse(
        config.get('KNOWLEDGE_VECTOR_CANDIDATE_MIN_SIMILARITY') ??
          DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY,
      );
    this.lexicalNoiseFloor = z.coerce
      .number()
      .nonnegative()
      .parse(
        config.get('KNOWLEDGE_LEXICAL_CANDIDATE_MIN_SCORE') ??
          DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE,
      );
  }

  /** Single deterministic pass: cache -> DB -> ONE embedding -> both sources. */
  async retrieve(
    message: string,
    context: RetrievalContext = {},
  ): Promise<KnowledgeRetrievalResult> {
    const result = await this.runRetrieval(message, context);
    this.logRetrieval(message, result);
    return result;
  }

  private async runRetrieval(
    message: string,
    context: RetrievalContext = {},
  ): Promise<KnowledgeRetrievalResult> {
    const resolved = resolveRetrievalQuery(
      redactPii(message),
      context.recentMessages ?? [],
    );

    if (resolved.missingReference) {
      return this.result([], [], 'LOW_CONFIDENCE', 'MISSING_USER_INFORMATION');
    }

    const query = resolved.query;

    if (query !== message.trim())
      this.logger.debug(
        logBlock('Retrieval', [
          'follow-up rewritten',
          `query=${JSON.stringify(logSafeText(query))}`,
        ]),
      );

    if (!normalizeText(query)) {
      return this.result([], [], 'LOW_CONFIDENCE', 'NO_SEARCH_RESULTS');
    }

    let failed = false;

    const read = async (
      label: string,
      call: () => Promise<KnowledgeItem[]> | KnowledgeItem[],
    ) => {
      try {
        return (await call()).filter((item) => this.eligible(item));
      } catch (error) {
        rethrowPendingAiUsage(error);
        failed = true;
        this.logger.warn(`${label} knowledge retrieval failed`);
        return [];
      }
    };

    const cached = await read('cache', () =>
      this.patterns.findMatchesFromPatterns(
        query,
        this.cache.getAll(),
        'CACHE',
      ),
    );
    // A follow-up is not the customer's verbatim approved question.
    const directAllowed = query === message.trim();
    const fastCached = directAllowed ? this.directResult(cached) : undefined;
    if (fastCached) return fastCached;

    failed = false; // A successful DB fallback recovers a cache read failure.
    const database = await read('database', () =>
      this.patterns.findMatches(query),
    );
    // DB is authoritative; never resurrect a stale cache candidate after a miss.
    const fastDatabase = directAllowed
      ? this.directResult(database)
      : undefined;
    if (fastDatabase) return fastDatabase;

    const [micro, semantic] = await Promise.all([
      read('micro lexical', () => this.micro.findMatches(query)),
      read('semantic', () => this.semantic.search(query, context)),
    ]);
    const lexical = [...database, ...micro].filter(
      (item) =>
        item.metadata?.exactMatch === true ||
        this.raw(item, 'rawScore') >= this.lexicalNoiseFloor,
    );
    const vectors = semantic.filter(
      (item) => this.raw(item, 'vectorSimilarity') >= this.vectorNoiseFloor,
    );
    const merged = this.rank(lexical, vectors);
    const ranked = merged.slice(0, MAX_RETRIEVAL_CANDIDATES);
    // A missing source can hide an exception/conflict. Do not answer from a
    // partial pool while one of the required reads failed.
    if (failed)
      return this.result(ranked, [], 'LOW_CONFIDENCE', 'RETRIEVAL_ERROR');

    const selected = this.selectContexts(ranked);
    // A low-ranked, unrelated candidate must not veto the evidence actually
    // used. Check selected facts and their explicitly related companions.
    const related = merged.filter((item) =>
      selected.some((chosen) => this.related(chosen, item)),
    );
    if (
      this.conflicts([
        ...new Map(
          [...selected, ...related].map((item) => [this.key(item), item]),
        ).values(),
      ])
    )
      return this.result(
        ranked,
        [],
        'LOW_CONFIDENCE',
        'CONFLICTING_CANDIDATES',
      );
    return this.result(
      ranked,
      selected,
      selected.length ? 'RAG' : 'LOW_CONFIDENCE',
      selected.length ? undefined : 'NO_USABLE_EVIDENCE',
    );
  }

  private directResult(
    items: KnowledgeItem[],
  ): KnowledgeRetrievalResult | undefined {
    const exactItems = items.filter(
      (item) => item.metadata?.exactMatch === true,
    );
    if (
      exactItems.some((item) => item.metadata?.ambiguousExact === true) ||
      this.conflicts(exactItems)
    ) {
      return this.result(items, [], 'LOW_CONFIDENCE', 'CONFLICTING_CANDIDATES');
    }
    const exact = items.filter(
      (item) =>
        item.source === 'ANSWER_PATTERN' &&
        item.metadata?.safeDirect === true &&
        item.renderMode !== 'REWRITE',
    );
    if (!exact.length) return undefined;
    // Multiple complete DIRECT presets with identical content are equivalent;
    // select deterministically. REWRITE must continue through unified
    // retrieval so relevant MicroKnowledge can also ground the model call.
    const winner = exact[0];
    return this.result(items, [winner], 'DIRECT');
  }

  private eligible(item: KnowledgeItem): boolean {
    return (
      item.metadata?.active === true &&
      item.metadata?.tenantId === this.scope.tenantId &&
      item.metadata?.language === this.scope.language &&
      Boolean(item.answer?.trim()) &&
      isUsableKnowledge(item) &&
      Number.isFinite(item.score)
    );
  }

  /** BM25 scores from different corpora are ranked separately before RRF. */
  private rank(
    lexical: KnowledgeItem[],
    vectors: KnowledgeItem[],
  ): KnowledgeItem[] {
    const lists = [
      ...(['ANSWER_PATTERN', 'MICRO_KNOWLEDGE'] as const).map((source) =>
        lexical
          .filter((item) => item.source === source)
          .sort(
            (a, b) =>
              this.raw(b, 'rawScore') - this.raw(a, 'rawScore') ||
              this.tieBreak(a, b),
          ),
      ),
      [...vectors].sort(
        (a, b) =>
          this.raw(b, 'vectorSimilarity') - this.raw(a, 'vectorSimilarity') ||
          this.tieBreak(a, b),
      ),
    ];
    const merged = new Map<string, KnowledgeItem>();
    for (const [channel, list] of lists.entries()) {
      const seen = new Set<string>();
      for (const [index, item] of list.entries()) {
        const key = this.key(item);
        if (seen.has(key)) continue;
        seen.add(key);
        const previous = merged.get(key);
        merged.set(key, {
          ...item,
          // Lexical DB content wins over a vector hit for the same source/ID.
          ...previous,
          score: (previous?.score ?? 0) + 1 / (RRF_RANK_CONSTANT + index + 1),
          metadata: {
            ...previous?.metadata,
            ...item.metadata,
            exactMatch:
              previous?.metadata?.exactMatch === true ||
              item.metadata?.exactMatch === true,
            matchTypes: [
              ...new Set([
                ...((previous?.metadata?.matchTypes as string[]) ?? []),
                channel === 2 ? 'EMBEDDING' : 'KEYWORD',
              ]),
            ],
          },
        });
      }
    }
    return [...merged.values()].sort(
      (a, b) => b.score - a.score || this.tieBreak(a, b),
    );
  }

  private selectContexts(items: KnowledgeItem[]): KnowledgeItem[] {
    const selected: KnowledgeItem[] = [];
    let characters = 0;
    const first = items[0];
    const ordered = first
      ? [
          first,
          ...items.slice(1).filter((item) => this.related(first, item)),
          ...items.slice(1).filter((item) => !this.related(first, item)),
        ]
      : items;
    for (const item of ordered) {
      // Do not fill the remaining slots with unrelated vector neighbours.
      if (
        selected.length > 0 &&
        item.metadata?.exactMatch !== true &&
        !((item.metadata?.matchTypes as string[] | undefined) ?? []).includes(
          'KEYWORD',
        ) &&
        !this.related(selected[0], item)
      )
        continue;
      if (
        selected.some(
          (chosen) =>
            chosen.id !== item.id &&
            this.related(chosen, item) &&
            normalizeText(chosen.answer ?? '') ===
              normalizeText(item.answer ?? ''),
        )
      )
        continue;
      const length =
        (item.title?.length ?? 0) +
        (item.content?.length ?? 0) +
        (item.answer?.length ?? 0);
      // Keep facts whole: truncating could remove an exception or negation.
      if (characters + length > MAX_RAG_EVIDENCE_CHARACTERS) continue;
      selected.push(item);
      characters += length;
      if (selected.length === MAX_RAG_CONTEXTS) break;
    }
    return selected;
  }

  private conflicts(items: readonly KnowledgeItem[]): boolean {
    if (items.some((item) => item.metadata?.conflicting === true)) return true;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (this.key(a) === this.key(b)) continue;
        if (!this.related(a, b)) continue;
        const left = normalizeText(a.answer ?? '');
        const right = normalizeText(b.answer ?? '');
        if (left === right) continue;
        // A changed value in the same keyed assertion is a conflict even when
        // both versions describe a condition (e.g. free over 500 vs 700).
        const numericTemplate = (text: string) =>
          text.replace(/\d+(?:[.,]\d+)*/gu, '#');
        if (
          /\d/u.test(left) &&
          /\d/u.test(right) &&
          numericTemplate(left) === numericTemplate(right)
        )
          return true;
        // Different conditional cases are not competing unconditional facts.
        // Leave their interpretation to grounded answering (or its sentinel).
        const conditional =
          /ถ้า|เมื่อ|กรณี|สำหรับ|ซื้อ|ตั้งแต่|มากกว่า|น้อยกว่า|\b(?:if|when|for|over|under)\b/u;
        if (conditional.test(left) || conditional.test(right)) continue;
        // A narrow, same-assertion polarity check, not "same category + close score".
        const pa = this.assertion(left);
        const pb = this.assertion(right);
        if (pa.fact === pb.fact && pa.negative !== pb.negative) return true;
      }
    }
    return false;
  }

  private related(a: KnowledgeItem, b: KnowledgeItem): boolean {
    if (this.key(a) === this.key(b)) return true;
    const entityA = a.metadata?.entityKey;
    const entityB = b.metadata?.entityKey;
    const topicA = a.metadata?.topicKey;
    const topicB = b.metadata?.topicKey;
    if (entityA && entityB && entityA !== entityB) return false;
    if (topicA && topicB && topicA !== topicB) return false;
    if (entityA && entityB && topicA && topicB) return true;
    return (
      this.sharedQuestion(a, b) ||
      Boolean(
        a.title && normalizeText(a.title) === normalizeText(b.title ?? ''),
      )
    );
  }

  private assertion(text: string): { fact: string; negative: boolean } {
    // Normalize only explicit negations with an otherwise identical assertion.
    // Different wording/conditions are not enough to infer a contradiction.
    const replacements: readonly (readonly [RegExp, string])[] = [
      [/ไม่ได้/gu, 'ได้'],
      [/ไม่รองรับ/gu, 'รองรับ'],
      [/ไม่อนุญาต/gu, 'อนุญาต'],
      [/ไม่สามารถ/gu, 'สามารถ'],
      [/ห้ามซัก/gu, 'ซักได้'],
      [/\b(?:cannot|can not)\b/gu, 'can'],
      [/\bmust not be washed\b/gu, 'can be washed'],
      [/\bis not\b/gu, 'is'],
      [/\bare not\b/gu, 'are'],
      [/\bnot supported\b/gu, 'supported'],
    ];
    let fact = text;
    for (const [pattern, positive] of replacements)
      fact = fact.replace(pattern, positive);
    return { fact, negative: fact !== text };
  }

  private sharedQuestion(a: KnowledgeItem, b: KnowledgeItem): boolean {
    const questions = (item: KnowledgeItem) =>
      Array.isArray(item.metadata?.questionExamples)
        ? (item.metadata.questionExamples as string[])
            .map(normalizeText)
            .filter(Boolean)
        : [];
    const left = new Set(questions(a));
    return questions(b).some((question) => left.has(question));
  }

  private key(item: KnowledgeItem): string {
    return `${item.source}:${item.id}`;
  }
  private raw(item: KnowledgeItem, key: string): number {
    const value = item.metadata?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  private tieBreak(a: KnowledgeItem, b: KnowledgeItem): number {
    return (
      this.raw(b, 'priority') - this.raw(a, 'priority') ||
      this.key(a).localeCompare(this.key(b))
    );
  }
  /** "*" marks candidate context. The router may still choose general chat or handoff. */
  private logRetrieval(
    message: string,
    result: KnowledgeRetrievalResult,
  ): void {
    const selected = new Set(
      result.selectedItems.map((item) => this.key(item)),
    );
    const header = [
      `query=${JSON.stringify(logSafeText(message))}`,
      `route=${result.route}`,
      `match=${result.matchType}`,
      `candidates=${result.items.length}`,
      `contextCandidates=${result.selectedItems.length}`,
      `fallback=${result.fallbackReason ?? '-'}`,
    ];
    const shown = result.items.slice(0, MAX_LOGGED_CANDIDATES);
    const candidates = shown.flatMap((item, index) => {
      const mark = selected.has(this.key(item)) ? '*' : ' ';
      return [
        `  ${mark}#${index + 1} ${item.source}:${item.id}`,
        // RRF after rank(); the raw matcher score on the direct path.
        `       score=${item.score.toFixed(5)}`,
        `       lexical=${this.raw(item, 'rawScore')}`,
        `       vector=${this.raw(item, 'vectorSimilarity').toFixed(4)}`,
        `       priority=${this.raw(item, 'priority')}`,
        `       via=${((item.metadata?.matchTypes as string[]) ?? []).join('+') || 'NONE'}`,
        `       title=${JSON.stringify(item.title ?? '')}`,
      ];
    });
    const hidden = result.items.length - shown.length;
    this.logger.debug(
      logBlock('Retrieval', [
        ...header,
        candidates.length ? 'candidates:' : null,
        ...candidates,
        hidden > 0 ? `  … +${hidden} lower-ranked candidate(s)` : null,
      ]),
    );
  }

  private result(
    items: readonly KnowledgeItem[],
    selectedItems: readonly KnowledgeItem[],
    route: KnowledgeRetrievalResult['route'],
    fallbackReason?: string,
  ): KnowledgeRetrievalResult {
    const top = selectedItems[0] ?? items[0];
    const types = top?.metadata?.matchTypes as string[] | undefined;
    const matchType: KnowledgeMatchType = top?.metadata?.safeDirect
      ? 'EXACT'
      : types?.includes('KEYWORD') && types.includes('EMBEDDING')
        ? 'HYBRID'
        : types?.includes('EMBEDDING')
          ? 'EMBEDDING'
          : top
            ? 'KEYWORD'
            : 'NONE';
    return {
      route,
      items,
      selectedItems,
      matchType,
      fallbackReason,
      topScores: items.map((item) => item.score),
      scoreGap: items.length > 1 ? items[0].score - items[1].score : null,
    };
  }
}
