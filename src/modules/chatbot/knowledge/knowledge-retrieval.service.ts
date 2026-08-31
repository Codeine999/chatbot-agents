import { Injectable, Logger } from '@nestjs/common';
import { normalizeText } from '../../../utils/text.utils';
import {
  CLEAR_WINNER_GAP,
  DIRECT_IMMEDIALY,
  KEYWORD_SCORE_NORMALIZER,
  MAX_RAG_CONTEXTS,
  MAX_RETRIEVAL_ATTEMPTS,
  MAX_RETRIEVAL_CANDIDATES,
  MIN_CONTEXT_SCORE,
} from '../constants/knowledge-routing.constants';
import {
  ChatContextMessage,
  KnowledgeItem,
  KnowledgeMatchType,
  KnowledgeRetrievalAttempt,
  KnowledgeRetrievalDiagnosis,
  KnowledgeRetrievalResult,
  KnowledgeRewriteStrategy,
} from '../types/chat.types';
import { AnswerPatternCacheService } from './answer-pattern-cache.service';
import { AnswerPatternService } from './answer-pattern.service';
import {
  RetrievalDiagnosis,
  RetrievalQueryPlan,
  RetrievalQueryPlannerService,
} from './retrieval-query-planner.service';
import { SemanticSearchService } from './semantic-search.service';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';

type RetrievalContext = LineAiUsageContext &
  Readonly<{
    recentMessages?: readonly ChatContextMessage[];
  }>;

type CandidatePassResult = Readonly<{
  items: readonly KnowledgeItem[];
  retrievalFailed: boolean;
  directFastPath: boolean;
}>;

const ENGLISH_FOLLOW_UP_PATTERN =
  /(?:^|\s)(?:(?:it|this|that|these|those)(?:\s+one)?|same\s+as\s+before|same\s+one|as\s+before)(?=\s|$)/u;

const THAI_FOLLOW_UP_MARKERS = [
  'อันนี้',
  'อันนั้น',
  'ตัวนี้',
  'ตัวนั้น',
  'เมื่อกี้',
  'อันเดิม',
  'เหมือนเดิม',
  'เหมือนก่อน',
] as const;

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly answerPatternService: AnswerPatternService,
    private readonly answerPatternCacheService: AnswerPatternCacheService,
    private readonly semanticSearchService: SemanticSearchService,
    private readonly retrievalQueryPlannerService: RetrievalQueryPlannerService,
  ) {}

  /**
   * Retrieve once for obvious exact/clear winners. All other paths form a
   * broad hybrid pool and may run one bounded agentic second pass before
   * returning at most three contexts ordered by retrieval score.
   */
  async retrieve(
    message: string,
    context: RetrievalContext = {},
  ): Promise<KnowledgeRetrievalResult> {
    const originalQuestion = message.trim();
    const attemptedQueryKeys = new Set<string>();
    const attemptedQueries: string[] = [];
    const attempts: KnowledgeRetrievalAttempt[] = [];

    this.rememberQuery(originalQuestion, attemptedQueryKeys, attemptedQueries);

    const firstPass = await this.retrieveCandidatePass(
      originalQuestion,
      context.userId,
      1,
    );
    attempts.push(this.attemptSummary(1, originalQuestion, firstPass));

    let candidates = [...firstPass.items];
    let retrievalFailed = firstPass.retrievalFailed;
    let decision = this.decide(candidates);
    const requiresQueryAnalysis =
      this.looksLikeFollowUp(originalQuestion) ||
      this.looksComplex(originalQuestion);
    if (decision.route === 'LOW_CONFIDENCE' && retrievalFailed) {
      decision = { ...decision, fallbackReason: 'RETRIEVAL_ERROR' };
    }

    // Preserve the existing zero-LLM path for a unique exact match or a clear,
    // very-high-confidence winner from cache/DB.
    if (
      firstPass.directFastPath &&
      decision.route === 'DIRECT' &&
      !requiresQueryAnalysis
    ) {
      return this.finish(decision, {
        attempts,
        diagnosis: 'NONE',
        rewriteStrategy: 'NONE',
        plannerUsedLlm: false,
      });
    }

    let plan: RetrievalQueryPlan | undefined;
    const diagnosisHint = this.diagnosisHint(
      originalQuestion,
      context.recentMessages ?? [],
      decision,
      candidates,
    );

    if (this.shouldPlanSecondPass(originalQuestion, decision, candidates)) {
      plan = await this.retrievalQueryPlannerService.plan({
        originalQuery: originalQuestion,
        userId: context.userId,
        lineMemberId: context.lineMemberId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        recentMessages: context.recentMessages ?? [],
        candidates,
        attemptedQueries,
        fallbackReason: decision.fallbackReason,
        scoreGap: decision.scoreGap,
        diagnosisHint,
        allowLlm: diagnosisHint !== 'RETRIEVAL_ERROR',
      });
    }

    const secondPassQueries = this.acceptPlannedQueries(
      plan,
      attemptedQueryKeys,
      attemptedQueries,
      MAX_RETRIEVAL_ATTEMPTS - attempts.length,
    );

    if (
      secondPassQueries.length === 0 &&
      (plan?.diagnosis === 'MISSING_USER_INFORMATION' ||
        plan?.diagnosis === 'CONFLICTING_CANDIDATES')
    ) {
      decision = this.forceLowConfidence(decision, plan.diagnosis);
    }

    if (secondPassQueries.length > 0) {
      const passes = await Promise.all(
        secondPassQueries.map(({ query, attempt }) =>
          this.retrieveCandidatePass(query, context.userId, attempt),
        ),
      );

      for (let index = 0; index < passes.length; index += 1) {
        const pass = passes[index];
        const planned = secondPassQueries[index];
        if (!pass || !planned) continue;

        attempts.push(
          this.attemptSummary(planned.attempt, planned.query, pass),
        );
        retrievalFailed ||= pass.retrievalFailed;
        candidates = this.mergeAndRank(candidates, pass.items);
      }

      // A query generated from a previously-low/ambiguous request is evidence
      // for grounded generation, not permission to return a rewritten answer
      // verbatim. This preserves low-confidence -> rewrite -> LLM answering.
      decision = this.decide(candidates, {
        allowDirect: false,
      });

      if (
        plan?.diagnosis === 'CONFLICTING_CANDIDATES' &&
        this.hasConflictingCandidates(candidates)
      ) {
        decision = this.forceLowConfidence(decision, 'CONFLICTING_CANDIDATES');
      }
    }

    if (decision.route === 'LOW_CONFIDENCE' && retrievalFailed) {
      decision = { ...decision, fallbackReason: 'RETRIEVAL_ERROR' };
    }

    const result = this.finish(decision, {
      attempts,
      diagnosis: plan?.diagnosis ?? 'NONE',
      rewriteStrategy: plan?.strategy ?? 'NONE',
      plannerUsedLlm: plan?.usedLlm ?? false,
    });

    this.logger.debug(
      `[KnowledgeRetrieval] ${JSON.stringify({
        route: result.route,
        attemptCount: result.attemptCount,
        candidateCount: result.items.length,
        selectedKnowledgeIds: result.selectedItems.map((item) => item.id),
        diagnosis: result.diagnosis,
        rewriteStrategy: result.rewriteStrategy,
        plannerUsedLlm: result.plannerUsedLlm,
        fallbackReason: result.fallbackReason ?? null,
      })}`,
    );

    return result;
  }

  private async retrieveCandidatePass(
    query: string,
    userId: string | undefined,
    attempt: number,
  ): Promise<CandidatePassResult> {
    if (!normalizeText(query)) {
      return { items: [], retrievalFailed: false, directFastPath: false };
    }

    let retrievalFailed = false;
    let cacheItems: KnowledgeItem[] = [];

    try {
      const matches = this.answerPatternService.findMatchesFromPatterns(
        query,
        this.answerPatternCacheService.getAll(),
        'CACHE',
      );
      cacheItems = matches.map((item) =>
        this.annotateAttempt(this.normalizeKeywordScore(item), attempt, query),
      );
    } catch (error) {
      retrievalFailed = true;
      this.logger.error('cached knowledge retrieval failed', error as Error);
    }

    const cacheDecision = this.decide(cacheItems);
    if (cacheDecision.route === 'DIRECT') {
      return {
        items: cacheDecision.items,
        retrievalFailed,
        directFastPath: true,
      };
    }

    let databaseItems: KnowledgeItem[] = [];
    let databaseSucceeded = false;

    try {
      const matches = await this.answerPatternService.findMatches(query);
      databaseItems = matches.map((item) =>
        this.annotateAttempt(this.normalizeKeywordScore(item), attempt, query),
      );
      databaseSucceeded = true;
    } catch (error) {
      retrievalFailed = true;
      this.logger.error('database knowledge retrieval failed', error as Error);
    }

    // A successful DB lookup is authoritative over a possibly stale cache.
    const keywordItems = databaseSucceeded ? databaseItems : cacheItems;
    const databaseDecision = this.decide(keywordItems);
    if (databaseDecision.route === 'DIRECT') {
      return {
        items: databaseDecision.items,
        retrievalFailed,
        directFastPath: true,
      };
    }

    let semanticItems: KnowledgeItem[] = [];
    try {
      const matches = await this.semanticSearchService.search(query, userId);
      semanticItems = matches.map((item) =>
        this.annotateAttempt(item, attempt, query),
      );
    } catch (error) {
      retrievalFailed = true;
      this.logger.warn(
        `embedding knowledge retrieval failed: ${String(error)}`,
      );
    }

    return {
      items: this.mergeAndRank(keywordItems, semanticItems),
      retrievalFailed,
      directFastPath: false,
    };
  }

  private normalizeKeywordScore(item: KnowledgeItem): KnowledgeItem {
    const parsedRawScore = Number(item.metadata?.rawScore ?? item.score);
    const rawScore = Number.isFinite(parsedRawScore) ? parsedRawScore : 0;
    const score = this.roundScore(
      Math.min(Math.max(rawScore / KEYWORD_SCORE_NORMALIZER, 0), 1),
    );

    return {
      ...item,
      score,
      metadata: {
        ...item.metadata,
        rawScore,
        matchTypes: this.matchTypes(item),
      },
    };
  }

  private annotateAttempt(
    item: KnowledgeItem,
    attempt: number,
    query: string,
  ): KnowledgeItem {
    return {
      ...item,
      score: this.normalizeScore(item.score),
      metadata: {
        ...item.metadata,
        retrievalAttempts: this.uniqueNumbers(
          this.metadataNumbers(item, 'retrievalAttempts'),
          [attempt],
        ),
        retrievalQueries: this.uniqueStrings(
          this.metadataStrings(item, 'retrievalQueries'),
          [query],
        ),
      },
    };
  }

  private mergeAndRank(
    ...candidateGroups: readonly (readonly KnowledgeItem[])[]
  ): KnowledgeItem[] {
    const byKey = new Map<string, KnowledgeItem>();
    const idToKey = new Map<string, string>();
    const fingerprintToKey = new Map<string, string>();

    for (const rawItem of candidateGroups.flat()) {
      const item = { ...rawItem, score: this.normalizeScore(rawItem.score) };
      const fingerprint = this.candidateFingerprint(item);
      const key =
        idToKey.get(item.id) ??
        (fingerprint ? fingerprintToKey.get(fingerprint) : undefined) ??
        `id:${item.id}`;
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, {
          ...item,
          metadata: {
            ...item.metadata,
            matchTypes: this.matchTypes(item),
          },
        });
        idToKey.set(item.id, key);
        if (fingerprint) fingerprintToKey.set(fingerprint, key);
        continue;
      }

      const preferred = item.score > existing.score ? item : existing;
      const secondary = preferred === item ? existing : item;
      const matchTypes = this.uniqueStrings(
        this.matchTypes(existing),
        this.matchTypes(item),
      );
      const rawScore = Math.max(
        this.metadataFiniteNumber(existing, 'rawScore') ?? 0,
        this.metadataFiniteNumber(item, 'rawScore') ?? 0,
      );
      const duplicateKnowledgeIds = this.uniqueStrings(
        this.metadataStrings(existing, 'duplicateKnowledgeIds'),
        this.metadataStrings(item, 'duplicateKnowledgeIds'),
        existing.id === item.id ? [] : [existing.id, item.id],
      );

      byKey.set(key, {
        ...preferred,
        score: this.normalizeScore(Math.max(existing.score, item.score)),
        answer: preferred.answer ?? existing.answer ?? item.answer,
        metadata: {
          ...secondary.metadata,
          ...preferred.metadata,
          ...(rawScore > 0 ? { rawScore } : {}),
          ...(duplicateKnowledgeIds.length > 0
            ? { duplicateKnowledgeIds }
            : {}),
          exactMatch:
            existing.metadata?.exactMatch === true ||
            item.metadata?.exactMatch === true,
          matchTypes,
          retrievalAttempts: this.uniqueNumbers(
            this.metadataNumbers(existing, 'retrievalAttempts'),
            this.metadataNumbers(item, 'retrievalAttempts'),
          ),
          retrievalQueries: this.uniqueStrings(
            this.metadataStrings(existing, 'retrievalQueries'),
            this.metadataStrings(item, 'retrievalQueries'),
          ),
        },
      });
      idToKey.set(existing.id, key);
      idToKey.set(item.id, key);
      if (fingerprint) fingerprintToKey.set(fingerprint, key);
    }

    return Array.from(byKey.values())
      .sort((left, right) => this.compareCandidates(left, right))
      .slice(0, MAX_RETRIEVAL_CANDIDATES);
  }

  private decide(
    items: readonly KnowledgeItem[],
    options: Readonly<{
      allowDirect?: boolean;
    }> = {},
  ): KnowledgeRetrievalResult {
    const ranked = [...items]
      .sort((left, right) => this.compareCandidates(left, right))
      .slice(0, MAX_RETRIEVAL_CANDIDATES);
    const [top, second] = ranked;
    const scoreGap =
      top && second ? this.roundScore(top.score - second.score) : null;
    const topScores = ranked.map((item) => this.roundScore(item.score));

    if (!top) {
      return {
        route: 'LOW_CONFIDENCE',
        matchType: 'NONE',
        items: ranked,
        selectedItems: [],
        topScores,
        scoreGap,
        fallbackReason: 'NO_SEARCH_RESULTS',
      };
    }

    const exactMatch = this.isExact(top);
    const clearWinner = !second || (scoreGap ?? 0) >= CLEAR_WINNER_GAP;
    const allowDirect = options.allowDirect !== false;

    if (
      allowDirect &&
      (exactMatch || (top.score >= DIRECT_IMMEDIALY && clearWinner))
    ) {
      return {
        route: 'DIRECT',
        matchType: this.matchType(top),
        items: ranked,
        selectedItems: [top],
        topScores,
        scoreGap,
      };
    }

    const topEligible = ranked.find((item) => item.score >= MIN_CONTEXT_SCORE);
    if (topEligible) {
      return {
        route: 'RAG',
        matchType: this.matchType(topEligible),
        items: ranked,
        selectedItems: this.selectRagContexts(ranked),
        topScores,
        scoreGap,
      };
    }

    return {
      route: 'LOW_CONFIDENCE',
      matchType: this.matchType(top),
      items: ranked,
      selectedItems: [],
      topScores,
      scoreGap,
      fallbackReason: 'BELOW_MIN_CONTEXT_SCORE',
    };
  }

  private forceLowConfidence(
    decision: KnowledgeRetrievalResult,
    fallbackReason: string,
  ): KnowledgeRetrievalResult {
    return {
      ...decision,
      route: 'LOW_CONFIDENCE',
      selectedItems: [],
      fallbackReason,
    };
  }

  private selectRagContexts(items: readonly KnowledgeItem[]): KnowledgeItem[] {
    return items
      .filter((item) => item.score >= MIN_CONTEXT_SCORE)
      .slice(0, MAX_RAG_CONTEXTS);
  }

  private shouldPlanSecondPass(
    originalQuestion: string,
    decision: KnowledgeRetrievalResult,
    items: readonly KnowledgeItem[],
  ): boolean {
    if (items.length === 0 && this.looksObviouslyGeneral(originalQuestion)) {
      return false;
    }
    if (
      this.looksLikeFollowUp(originalQuestion) ||
      this.looksComplex(originalQuestion)
    ) {
      return true;
    }
    if (decision.route === 'DIRECT') return false;

    return (
      decision.route === 'LOW_CONFIDENCE' ||
      this.isAmbiguous(decision) ||
      this.hasConflictingCandidates(items)
    );
  }

  private diagnosisHint(
    originalQuestion: string,
    recentMessages: readonly ChatContextMessage[],
    decision: KnowledgeRetrievalResult,
    items: readonly KnowledgeItem[],
  ): RetrievalDiagnosis {
    if (decision.fallbackReason === 'RETRIEVAL_ERROR') {
      return 'RETRIEVAL_ERROR';
    }
    if (this.hasConflictingCandidates(items)) {
      return 'CONFLICTING_CANDIDATES';
    }
    if (this.looksComplex(originalQuestion)) return 'COMPLEX_QUERY';
    if (this.looksLikeFollowUp(originalQuestion)) {
      return recentMessages.some((message) => message.role === 'user')
        ? 'AMBIGUOUS_RESULTS'
        : 'MISSING_USER_INFORMATION';
    }
    if (this.isAmbiguous(decision)) return 'AMBIGUOUS_RESULTS';
    return 'MISSING_KNOWLEDGE_EVIDENCE';
  }

  private isAmbiguous(decision: KnowledgeRetrievalResult): boolean {
    return (
      decision.items.length > 1 &&
      decision.scoreGap !== null &&
      decision.scoreGap < CLEAR_WINNER_GAP
    );
  }

  private hasConflictingExactCandidates(
    items: readonly KnowledgeItem[],
  ): boolean {
    const exactItems = items.filter((item) => this.isExact(item));
    if (exactItems.length < 2) return false;

    const answers = new Set(
      exactItems
        .map((item) => normalizeText(item.answer ?? item.content))
        .filter(Boolean),
    );
    return answers.size > 1;
  }

  private hasConflictingCandidates(items: readonly KnowledgeItem[]): boolean {
    if (
      items.some(
        (item) =>
          item.metadata?.conflicting === true ||
          item.metadata?.conflict === true,
      )
    ) {
      return true;
    }
    if (this.hasConflictingExactCandidates(items)) return true;

    const [first, second] = [...items].sort(
      (left, right) => right.score - left.score,
    );
    if (!first || !second) return false;
    if (Math.abs(first.score - second.score) > CLEAR_WINNER_GAP) return false;

    const firstAnswer = normalizeText(first.answer ?? first.content);
    const secondAnswer = normalizeText(second.answer ?? second.content);
    if (!firstAnswer || !secondAnswer || firstAnswer === secondAnswer) {
      return false;
    }

    const firstIntent = this.metadataText(first, 'intentKey');
    const secondIntent = this.metadataText(second, 'intentKey');
    if (firstIntent && firstIntent === secondIntent) return true;

    const firstCategory = normalizeText(first.category ?? '');
    const secondCategory = normalizeText(second.category ?? '');
    return Boolean(firstCategory && firstCategory === secondCategory);
  }

  private looksLikeFollowUp(message: string): boolean {
    const normalized = normalizeText(message);
    if (!normalized) return false;

    return (
      normalized.startsWith('แล้ว') ||
      THAI_FOLLOW_UP_MARKERS.some((marker) => normalized.includes(marker)) ||
      ENGLISH_FOLLOW_UP_PATTERN.test(normalized)
    );
  }

  private looksComplex(message: string): boolean {
    const normalized = normalizeText(message);
    const questionMarks = message.match(/[?？]/gu)?.length ?? 0;

    return (
      questionMarks > 1 ||
      /(?:^|\s)(?:and|also|plus)(?=\s|$)/u.test(normalized) ||
      normalized.includes(' และ ') ||
      normalized.includes(' รวมทั้ง ') ||
      /[\p{L}\p{M}]{2,}และ[\p{L}\p{M}]{2,}/u.test(normalized)
    );
  }

  private looksObviouslyGeneral(message: string): boolean {
    const normalized = normalizeText(message);
    if (!normalized) return true;

    const businessMarkers = [
      'ราคา',
      'ค่าจัดส่ง',
      'จัดส่ง',
      'สินค้า',
      'บริการ',
      'แพ็กเกจ',
      'สมัคร',
      'ชำระ',
      'บัญชี',
      'นโยบาย',
      'price',
      'shipping',
      'delivery',
      'product',
      'service',
      'package',
      'register',
      'payment',
      'account',
      'policy',
    ];
    if (businessMarkers.some((marker) => normalized.includes(marker))) {
      return false;
    }

    const thaiMarkers = [
      'สวัสดี',
      'หวัดดี',
      'ขอบคุณ',
      'เป็นไง',
      'ทำอะไรอยู่',
      'คุณคือใคร',
    ];
    if (thaiMarkers.some((marker) => normalized.includes(marker))) return true;

    return /(?:^|\s)(?:hi|hello|thanks|thank\s+you|how\s+are\s+you|who\s+are\s+you)(?=\s|$)/u.test(
      normalized,
    );
  }

  private acceptPlannedQueries(
    plan: RetrievalQueryPlan | undefined,
    attemptedQueryKeys: Set<string>,
    attemptedQueries: string[],
    remainingAttempts: number,
  ): Array<{ query: string; attempt: number }> {
    if (!plan?.shouldRetry || remainingAttempts <= 0) return [];

    const accepted: Array<{ query: string; attempt: number }> = [];
    for (const rawQuery of plan.queries) {
      if (accepted.length >= remainingAttempts) break;

      const query = rawQuery.trim();
      if (!this.rememberQuery(query, attemptedQueryKeys, attemptedQueries)) {
        continue;
      }

      accepted.push({ query, attempt: 2 + accepted.length });
    }

    return accepted;
  }

  private rememberQuery(
    query: string,
    attemptedQueryKeys: Set<string>,
    attemptedQueries: string[],
  ): boolean {
    const key = normalizeText(query);
    if (!key || attemptedQueryKeys.has(key)) return false;

    attemptedQueryKeys.add(key);
    attemptedQueries.push(query);
    return true;
  }

  private attemptSummary(
    attempt: number,
    query: string,
    pass: CandidatePassResult,
  ): KnowledgeRetrievalAttempt {
    return {
      attempt,
      query,
      candidateCount: pass.items.length,
      retrievalFailed: pass.retrievalFailed,
    };
  }

  private finish(
    decision: KnowledgeRetrievalResult,
    diagnostics: Readonly<{
      attempts: readonly KnowledgeRetrievalAttempt[];
      diagnosis: KnowledgeRetrievalDiagnosis;
      rewriteStrategy: KnowledgeRewriteStrategy;
      plannerUsedLlm: boolean;
    }>,
  ): KnowledgeRetrievalResult {
    return {
      ...decision,
      attemptCount: diagnostics.attempts.length,
      attempts: diagnostics.attempts,
      diagnosis: diagnostics.diagnosis,
      rewriteStrategy: diagnostics.rewriteStrategy,
      plannerUsedLlm: diagnostics.plannerUsedLlm,
    };
  }

  private matchType(item: KnowledgeItem): KnowledgeMatchType {
    const types = this.matchTypes(item);
    if (this.isExact(item)) return 'EXACT';
    if (types.includes('KEYWORD') && types.includes('EMBEDDING')) {
      return 'HYBRID';
    }
    if (types.includes('EMBEDDING')) return 'EMBEDDING';
    if (types.includes('KEYWORD')) return 'KEYWORD';
    return 'NONE';
  }

  private isExact(item: KnowledgeItem): boolean {
    return (
      item.metadata?.exactMatch === true ||
      this.matchTypes(item).includes('EXACT')
    );
  }

  private matchTypes(item: KnowledgeItem): string[] {
    const value = item.metadata?.matchTypes;
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is string => typeof entry === 'string',
      );
    }

    return item.source === 'SEMANTIC_CHUNK' ? ['EMBEDDING'] : ['KEYWORD'];
  }

  private candidateFingerprint(item: KnowledgeItem): string | null {
    const parts = [item.title ?? '', item.content, item.answer ?? ''].map(
      (value) => normalizeText(value),
    );
    return parts.some(Boolean) ? parts.join('\u0000') : null;
  }

  private metadataStrings(item: KnowledgeItem, key: string): string[] {
    const value = item.metadata?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  private metadataText(item: KnowledgeItem, key: string): string | null {
    const value = item.metadata?.[key];
    return typeof value === 'string' && value.trim()
      ? normalizeText(value)
      : null;
  }

  private metadataNumbers(item: KnowledgeItem, key: string): number[] {
    const value = item.metadata?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is number =>
        typeof entry === 'number' && Number.isFinite(entry),
    );
  }

  private metadataFiniteNumber(
    item: KnowledgeItem,
    key: string,
  ): number | null {
    const value = Number(item.metadata?.[key]);
    return Number.isFinite(value) ? value : null;
  }

  private uniqueStrings(...groups: readonly string[][]): string[] {
    return Array.from(new Set(groups.flat()));
  }

  private uniqueNumbers(...groups: readonly number[][]): number[] {
    return Array.from(new Set(groups.flat())).sort(
      (left, right) => left - right,
    );
  }

  private priority(item: KnowledgeItem): number {
    const value = Number(item.metadata?.priority ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  private compareCandidates(left: KnowledgeItem, right: KnowledgeItem): number {
    const leftExact = this.isExact(left);
    const rightExact = this.isExact(right);

    if (leftExact !== rightExact) {
      return Number(rightExact) - Number(leftExact);
    }

    if (leftExact) {
      // Stable Array.sort preserves retrieval order when exact priorities tie.
      return this.priority(right) - this.priority(left);
    }

    return (
      right.score - left.score || this.priority(right) - this.priority(left)
    );
  }

  private roundScore(value: number): number {
    return Number(value.toFixed(4));
  }

  private normalizeScore(value: number): number {
    const finiteValue = Number.isFinite(value) ? value : 0;
    return this.roundScore(Math.min(Math.max(finiteValue, 0), 1));
  }
}
