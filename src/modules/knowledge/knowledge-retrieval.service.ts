import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { rethrowPendingAiUsage } from '../usage/billing/pending-ai-usage.error';
import { rethrowInsufficientCredit } from '../usage/credit-point/insufficient-credit.exception';
import {
  logBlock,
  logSafeText,
  normalizeText,
  redactPii,
} from '../../utils/text.utils';
import {
  MAX_RAG_CONTEXTS,
  MAX_RETRIEVAL_CANDIDATES,
  DEFAULT_VECTOR_CANDIDATE_MIN_SIMILARITY,
  DEFAULT_LEXICAL_CANDIDATE_MIN_SCORE,
  DEFAULT_LEXICAL_MIN_COVERAGE,
  DEFAULT_RAG_MIN_VECTOR_SIMILARITY,
  MAX_RAG_EVIDENCE_CHARACTERS,
} from '../../shared/knowledge/knowledge-routing.constants';
import {
  ChatContextMessage,
  KnowledgeItem,
  KnowledgeRetrievalResult,
} from '../../shared/contracts/chat.types';
import { AnswerPatternCacheService } from './answer-pattern-cache.service';
import { AnswerPatternService } from './answer-pattern.service';
import { filterByPlace } from '../../shared/knowledge/knowledge-places';
import { MicroKnowledgeService } from './micro-knowledge.service';
import { SemanticSearchService } from './semantic-search.service';
import { resolveRetrievalQuery } from './retrieval-query-planner.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceScopeService } from '../commerce/commerce-scope.service';
import {
  catalogLexicon,
  loadCatalogContext,
} from '../products/search/catalog-fields';
import {
  knowledgeScope,
  KnowledgeScope,
} from '../../shared/knowledge/knowledge-scope';
import type { LineAiUsageContext } from '../usage/billing/ai-usage.types';
import { isUsableKnowledge } from './utils/knowledge-answer.policy';
import { ProductRetrievalService } from '../products/rag/product-retrieval.service';
import type { EmbeddingResult } from '../../infra/embedding/embedding-adapter.interface';
import { DecisionTraceService } from '../decision-log/decision-trace.service';
import {
  hasConflicts,
  isRelated,
  itemKey,
  lexicalCoverage,
  rankCandidates,
  rawMetric,
  retrievalResult,
} from './retrieval-evidence';

/** Enough rows to explain the winner without burying the flow. */
const MAX_LOGGED_CANDIDATES = 5;

type RetrievalContext = LineAiUsageContext &
  Readonly<{
    recentMessages?: readonly ChatContextMessage[];
    disableProduct?: boolean;
    embedding?: EmbeddingResult;
    forceGrounded?: boolean;
  }>;

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);
  private readonly scope: KnowledgeScope;
  private readonly vectorNoiseFloor: number;
  private readonly lexicalNoiseFloor: number;
  private readonly lexicalMinCoverage: number;
  private readonly ragMinVectorSimilarity: number;

  constructor(
    private readonly patterns: AnswerPatternService,
    private readonly cache: AnswerPatternCacheService,
    private readonly semantic: SemanticSearchService,
    private readonly micro: MicroKnowledgeService,
    config: ConfigService,
    @Optional() private readonly products?: ProductRetrievalService,
    @Optional() private readonly decisionTrace?: DecisionTraceService,
    @Optional() private readonly scopes?: CommerceScopeService,
    @Optional() private readonly prisma?: PrismaService,
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
    this.lexicalMinCoverage = z.coerce
      .number()
      .min(0)
      .max(1)
      .parse(
        config.get('KNOWLEDGE_LEXICAL_MIN_COVERAGE') ??
          DEFAULT_LEXICAL_MIN_COVERAGE,
      );
    // Confidence gate on cosine similarity, also never compared with RRF.
    this.ragMinVectorSimilarity = z.coerce
      .number()
      .min(-1)
      .max(1)
      .parse(
        config.get('KNOWLEDGE_RAG_MIN_VECTOR_SIMILARITY') ??
          DEFAULT_RAG_MIN_VECTOR_SIMILARITY,
      );
  }

  /** Single deterministic pass: cache -> DB -> ONE embedding -> both sources. */
  async retrieve(
    message: string,
    context: RetrievalContext = {},
  ): Promise<KnowledgeRetrievalResult> {
    // The product gate may need the legacy result first; compute (and bill) it once.
    this.decisionTrace?.enter('retrieval');
    let legacy: Promise<KnowledgeRetrievalResult> | undefined;
    const runLegacy = () =>
      (legacy ??= this.matchKnowledgePipeline(message, context));
    const product = !context.disableProduct
      ? await this.products?.retrieveProduct(
          message,
          context,
          (query, embedding, forceGrounded) =>
            this.matchKnowledgePipeline(query, {
              ...context,
              turnId: context.turnId
                ? `product-policy:${context.turnId}`
                : undefined,
              embedding,
              forceGrounded,
            }),
          runLegacy,
        )
      : undefined;
    const result = product ?? (await runLegacy());
    this.logRetrieval(message, result);
    this.decisionTrace?.retrieval(result);
    this.decisionTrace?.note('retrieval', {
      route: result.route,
      matchType: result.matchType,
      fallbackReason: result.fallbackReason ?? null,
      candidates: result.items.length,
      selected: result.selectedItems.map((item) => itemKey(item)),
      plannerIntent: result.plannerIntent ?? null,
      product: Boolean(result.product),
    });
    return result;
  }

  /**
   * Business wording that marks an item name ("รุ่น", "เส้นทาง", "หลักสูตร").
   * A deployment without a readable company falls back to ECOMMERCE, as the
   * catalog does everywhere else.
   */
  private async entityMarkers(): Promise<readonly string[]> {
    const fallback = catalogLexicon(null).entityMarkers;
    if (!this.scopes || !this.prisma) return fallback;
    try {
      const scope = await this.scopes.forLineDeployment();
      const catalog = await loadCatalogContext(this.prisma, scope);
      return catalog.lexicon.entityMarkers;
    } catch (error) {
      this.logger.warn(
        `business wording unavailable, using default: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return fallback;
    }
  }

  private async matchKnowledgePipeline(
    message: string,
    context: RetrievalContext = {},
  ): Promise<KnowledgeRetrievalResult> {
    const resolved = resolveRetrievalQuery(
      redactPii(message),
      context.recentMessages ?? [],
      await this.entityMarkers(),
    );

    if (resolved.missingReference) {
      return retrievalResult(
        [],
        [],
        'LOW_CONFIDENCE',
        'MISSING_USER_INFORMATION',
      );
    }

    const query = resolved.query;

    if (query !== message.trim()) {
      // PII redaction alone also changes the text; only history rewrites count.
      this.decisionTrace?.note('retrieval', {
        query,
        rewritten: query !== redactPii(message).trim(),
      });
      this.logger.debug(
        logBlock('Retrieval', [
          'follow-up rewritten',
          `query=${JSON.stringify(logSafeText(query))}`,
        ]),
      );
    }

    if (!normalizeText(query)) {
      return retrievalResult([], [], 'LOW_CONFIDENCE', 'NO_SEARCH_RESULTS');
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
        rethrowInsufficientCredit(error);
        failed = true;
        this.logger.warn(
          `${label} knowledge retrieval failed (${error instanceof Error ? error.name : 'unknown error'})`,
        );
        return [];
      }
    };

    // One in-memory snapshot serves both lexical sources. Without a fresh one
    // (expired, or never loaded) the database is read as before.
    const snapshot = this.cache.snapshot();

    const cached = await read('cache', () =>
      this.patterns.findMatchesFromPatterns(
        query,
        snapshot?.patterns ?? this.cache.getAll(),
        'CACHE',
      ),
    );

    // A follow-up is not the customer's verbatim approved question.
    const directAllowed = query === message.trim() && !context.forceGrounded;
    const fastCached = directAllowed ? this.directResult(cached) : undefined;
    if (fastCached) return fastCached;

    // The snapshot holds the rows the database query would return, so a
    // successful snapshot read replaces it; a failed one falls back to the DB.
    const fresh = snapshot && !failed ? snapshot : null;
    failed = false; // A successful DB fallback recovers a cache read failure.
    const database = fresh
      ? cached
      : await read('database', () => this.patterns.findMatches(query));
    // DB is authoritative; never resurrect a stale cache candidate after a miss.
    const fastDatabase =
      directAllowed && !fresh ? this.directResult(database) : undefined;
    if (fastDatabase) return fastDatabase;

    const [micro, semantic] = await Promise.all([
      read('micro lexical', () => this.micro.findMatches(query, fresh?.micro)),
      read('semantic', () =>
        this.semantic.search(
          query,
          context,
          query === message.trim() ? context.embedding : undefined,
        ),
      ),
    ]);
    // A fact tied to another province/place must not answer this question.
    const places = fresh?.micro.map((row) => row.meta) ?? [];
    const lexical = [
      ...database,
      ...filterByPlace(micro, query, places),
    ].filter(
      (item) =>
        item.metadata?.exactMatch === true ||
        rawMetric(item, 'rawScore') >= this.lexicalNoiseFloor,
    );
    const vectors = filterByPlace(semantic, query, places).filter(
      (item) => rawMetric(item, 'vectorSimilarity') >= this.vectorNoiseFloor,
    );
    const merged = rankCandidates(lexical, vectors);
    const ranked = merged.slice(0, MAX_RETRIEVAL_CANDIDATES);
    // A missing source can hide an exception/conflict. Do not answer from a
    // partial pool while one of the required reads failed.
    if (failed)
      return retrievalResult(ranked, [], 'LOW_CONFIDENCE', 'RETRIEVAL_ERROR');

    const selected = this.selectContexts(ranked);
    // A low-ranked, unrelated candidate must not veto the evidence actually
    // used. Check selected facts and their explicitly related companions.
    const related = merged.filter((item) =>
      selected.some((chosen) => isRelated(chosen, item)),
    );
    if (
      hasConflicts([
        ...new Map(
          [...selected, ...related].map((item) => [itemKey(item), item]),
        ).values(),
      ])
    )
      return retrievalResult(
        ranked,
        [],
        'LOW_CONFIDENCE',
        'CONFLICTING_CANDIDATES',
      );
    if (!selected.length)
      return retrievalResult(
        ranked,
        [],
        'LOW_CONFIDENCE',
        'NO_USABLE_EVIDENCE',
      );
    // A shared word ranks a FAQ for "ยังอยู่ไหมคะ" too, so only an approved
    // exact question or a close vector hit is confident enough to skip the
    // BUSINESS/GENERAL classifier. Below it the candidates stay selected so a
    // BUSINESS classification can still ground its answer on them.
    // Judged on the selected evidence, not on any candidate: a strong hit that
    // is not sent to the model must not vouch for the one that is.
    const topVector = Math.max(
      0,
      ...selected.map((item) => rawMetric(item, 'vectorSimilarity')),
    );
    const confident =
      selected.some((item) => item.metadata?.exactMatch === true) ||
      topVector >= this.ragMinVectorSimilarity;
    return confident
      ? retrievalResult(ranked, selected, 'RAG')
      : retrievalResult(
          ranked,
          selected,
          'LOW_CONFIDENCE',
          'BELOW_MIN_VECTOR_SIMILARITY',
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
      hasConflicts(exactItems)
    ) {
      return retrievalResult(
        items,
        [],
        'LOW_CONFIDENCE',
        'CONFLICTING_CANDIDATES',
      );
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
    return retrievalResult(items, [winner], 'DIRECT');
  }

  private eligible(item: KnowledgeItem): boolean {
    return (
      item.metadata?.active === true &&
      item.metadata?.tenantId === this.scope.tenantId &&
      item.metadata?.language === this.scope.language &&
      Boolean(item.answer?.trim()) &&
      // isUsableKnowledge(item) &&
      Number.isFinite(item.score)
    );
  }

  private selectContexts(items: KnowledgeItem[]): KnowledgeItem[] {
    const selected: KnowledgeItem[] = [];
    let characters = 0;
    const strongVector = (item: KnowledgeItem) =>
      rawMetric(item, 'vectorSimilarity') >= this.ragMinVectorSimilarity;
    // RRF ranks a keyword-only hit level with a semantic hit. When the top item
    // has no semantic support, anchor on the best confident vector hit instead.
    let first = items[0];
    if (first && first.metadata?.exactMatch !== true && !strongVector(first)) {
      const semantic = items
        .filter(strongVector)
        .sort(
          (a, b) =>
            rawMetric(b, 'vectorSimilarity') - rawMetric(a, 'vectorSimilarity'),
        )[0];
      if (semantic) first = semantic;
    }
    const rest = items.filter((item) => item !== first);
    const ordered = first
      ? [
          first,
          ...rest.filter((item) => isRelated(first, item)),
          ...rest.filter((item) => !isRelated(first, item)),
        ]
      : items;
    for (const item of ordered) {
      // Do not fill the remaining slots with unrelated vector neighbours. A
      // confident vector hit is not a neighbour: a second topic in the same
      // message (shipping time and packing) arrives only this way.
      // The first item is never dropped here: a keyword-only extra must cover
      // enough of the question to be worth a slot, otherwise a shared everyday
      // word fills the model's context with unrelated FAQs.
      if (
        selected.length > 0 &&
        item.metadata?.exactMatch !== true &&
        rawMetric(item, 'vectorSimilarity') === 0 &&
        lexicalCoverage(item) < this.lexicalMinCoverage
      )
        continue;
      if (
        selected.length > 0 &&
        item.metadata?.exactMatch !== true &&
        !strongVector(item) &&
        !((item.metadata?.matchTypes as string[] | undefined) ?? []).includes(
          'KEYWORD',
        ) &&
        !isRelated(selected[0], item)
      )
        continue;
      if (
        selected.some(
          (chosen) =>
            chosen.id !== item.id &&
            isRelated(chosen, item) &&
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
  /** "*" marks candidate context. The router may still choose general chat or handoff. */
  private logRetrieval(
    message: string,
    result: KnowledgeRetrievalResult,
  ): void {
    const selected = new Set(result.selectedItems.map((item) => itemKey(item)));
    const header = [
      `query=${JSON.stringify(logSafeText(message))}`,
      `route=${result.route}`,
      `match=${result.matchType}`,
      `candidates=${result.items.length}`,
      `contextCandidates=${result.selectedItems.length}`,
      `fallback=${result.fallbackReason ?? '-'}`,
      ...(result.product
        ? [
            `productMode=${result.product.plan.mode}`,
            `productStatus=${result.product.result.status}`,
            `productFailed=${result.product.failed ?? false}`,
            `productChoices=${result.product.result.choices.length}`,
          ]
        : []),
    ];
    const shown = result.items.slice(0, MAX_LOGGED_CANDIDATES);
    const candidates = shown.flatMap((item, index) => {
      const mark = selected.has(itemKey(item)) ? '*' : ' ';
      return [
        `  ${mark}#${index + 1} ${item.source}:${item.id}`,
        // RRF after rank(); the raw matcher score on the direct path.
        `       score=${item.score.toFixed(5)}`,
        `       lexical=${rawMetric(item, 'rawScore')}`,
        `       vector=${rawMetric(item, 'vectorSimilarity').toFixed(4)}`,
        `       priority=${rawMetric(item, 'priority')}`,
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
}
