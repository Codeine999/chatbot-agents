import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from '../../../ai-provider/utils/ai-provider.constants';
import { CommerceFeatureService } from '../../commerce/commerce-feature.service';
import { CommerceScopeService } from '../../commerce/commerce-scope.service';
import { CommerceTurnService } from './commerce-turn.service';
import { buildProductPlannerPrompt } from './utils/prompt/product-prompt';
import { isStandalonePolicyQuestion } from './utils/policy-question';
import { ProductSearchService } from '../search/product-search.service';
import {
  groundAskFields,
  groundStockFilter,
} from '../search/product-plan-policy';
import {
  plannerSchemaFor,
  productPlanSchema,
  type ProductPlan,
  type ProductSearchResult,
} from '../search/product-search.types';
import { EmbeddingService } from '../../ai/embedding/embedding.service';
import type { EmbeddingResult } from '../../../infra/embedding/embedding-adapter.interface';
import type {
  AiRequestContext,
  KnowledgeRetrievalResult,
  ChatContextMessage,
  RetrievalFallbackReason,
} from '../../../shared/contracts/chat.types';
import { toAiProviderMessages } from '../../ai/prompt/ai-provider-context';
import { redactBotReply, redactPii } from '../../../utils/text.utils';
import { stripJsonCodeFence } from '../../../utils/json.utils';
import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import { rethrowInsufficientCredit } from '../../usage/credit-point/insufficient-credit.exception';
import { Prisma, type CommerceTurn } from '../../../generated/prisma/client';
import type { CommerceScope } from '../../commerce/types/commerce-scope';
import { DecisionTraceService } from '../../decision-log/decision-trace.service';
import type { CatalogContext } from '../search/product-search.service';
import { catalogLexicon } from '../search/catalog-fields';
import type { BusinessLexicon } from '../attributes/types/attribute-definition.types';
import { matchesSignals, matchesWholeMessage } from '../business/lexicon-match';
import { ProductClock } from '../time/product-clock';
import { commerceOwner } from './commerce-owner';
import { plannerTimeContext, todayIn } from '../time/product-calendar';
import {
  parseQuantity,
  parseThaiDateTime,
} from '../../../shared/text/thai-datetime';

type DateSource = 'PARSER' | 'MODEL' | 'PARSER_OVERRIDE' | 'NONE';
type KnowledgeRead = (
  query: string,
  embedding?: EmbeddingResult,
  forceGrounded?: boolean,
) => Promise<KnowledgeRetrievalResult>;
type LegacyRead = () => Promise<KnowledgeRetrievalResult>;
type StoredInput = {
  message: string;
  recentMessages: ChatContextMessage[];
  embeddingModel: string;
};
/**
 * Whole-message catalog opener; named products and list requests keep normal
 * search. The patterns belong to the business lexicon (default ECOMMERCE).
 */
export function isBroadProductInquiry(
  message: string,
  lexicon: BusinessLexicon = catalogLexicon(null),
): boolean {
  return matchesWholeMessage(lexicon.broadInquiry, message);
}

// Legacy outcomes the router already handles safely without a product planner.
const SETTLED_KNOWLEDGE: ReadonlySet<RetrievalFallbackReason> = new Set([
  'CONFLICTING_CANDIDATES',
  'RETRIEVAL_ERROR',
  'MISSING_USER_INFORMATION',
]);

@Injectable()
export class ProductRetrievalService {
  private readonly logger = new Logger(ProductRetrievalService.name);
  constructor(
    private readonly features: CommerceFeatureService,
    private readonly scopes: CommerceScopeService,
    private readonly turns: CommerceTurnService,
    private readonly products: ProductSearchService,
    private readonly embeddings: EmbeddingService,
    @Optional() private readonly decisionTrace?: DecisionTraceService,
    @Optional() clock?: ProductClock,
  ) {
    this.clock = clock ?? new ProductClock();
  }
  private readonly clock: ProductClock;

  /**
   * Returns a Product workflow, a planner-classified knowledge result, or
   * undefined to let the legacy knowledge route answer unchanged. FAQ and
   * small talk never reach product search: a confident knowledge hit with no
   * catalog signal returns before any planner call.
   */
  async retrieveProduct(
    message: string,
    context: AiRequestContext,
    knowledge: KnowledgeRead,
    legacy: LegacyRead = () => knowledge(message),
  ): Promise<KnowledgeRetrievalResult | undefined> {
    // Every channel with a durable conversation may use product RAG; a turn
    // without one (the back-office preview) has nothing to attach a turn to.
    const owner = commerceOwner(context);
    if (!this.features.productRagEnabled || !owner || !context.turnId)
      return undefined;
    const turnId = context.turnId;
    const connectionKey = this.features.connectionKeyFor(owner);

    let scope: CommerceScope;
    try {
      scope = await this.scopes.forLineDeployment();
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof ServiceUnavailableException
      ) {
        this.logger.warn(`Product RAG skipped: ${error.message}`);
        return undefined;
      }
      throw error;
    }

    // The wording that tells a policy question from a catalog one belongs to
    // the store's business preset, so it is read once per message, after scope.
    const catalog = await this.products.catalogContext(scope);
    const { lexicon } = catalog;
    if (isStandalonePolicyQuestion(message, lexicon)) return undefined;

    const history = (context.recentMessages ?? [])
      .slice(-6)
      .filter((m) => m.source !== 'REGISTRATION')
      .map((m) => ({
        ...m,
        text: (m.role === 'assistant'
          ? redactBotReply(m.text)
          : redactPii(m.text)
        ).slice(0, 1000),
      }));

    let turn: CommerceTurn | null;
    try {
      turn = await this.turns.find(scope, connectionKey, owner, turnId);

      if (!turn) {
        const routed = await this.routeWithoutPlanner(
          scope,
          message,
          history,
          legacy,
          catalog,
        );
        if (routed !== 'PLAN') return routed;
      }

      turn ??= await this.turns.open(scope, connectionKey, owner, turnId, {
        message: redactPii(message),
        recentMessages: history,
        embeddingModel: this.embeddings.model,
      });
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      this.logger.warn(`Product RAG skipped: ${error.message}`);
      return undefined;
    }

    if (turn.retrieval)
      return turn.retrieval as unknown as KnowledgeRetrievalResult;

    return this.turns.withLease(scope, turn.id, async (lease) => {
      if (lease.turn.retrieval)
        return lease.turn.retrieval as unknown as KnowledgeRetrievalResult;

      const input = lease.turn.input as unknown as StoredInput;
      const queryContext = {
        ...context,
        turnId: `product-query:${turn.id}:${input.embeddingModel}`,
        recentMessages: input.recentMessages,
      };

      let plan: ProductPlan;
      let failed = false;
      let plannedBusinessType: string | null | undefined;
      let dateSource: DateSource | undefined;
      const slots = catalog.capabilities.inventory === 'SLOT_CAPACITY';

      if (lease.turn.plan) {
        const stored = lease.turn.plan as unknown as {
          plan: ProductPlan;
          failed: boolean;
          businessType?: string | null;
          dateSource?: DateSource;
        };

        plan = productPlanSchema.parse(stored.plan);
        failed = stored.failed;
        plannedBusinessType = stored.businessType;
        dateSource = stored.dateSource;
      } else {
        if (isBroadProductInquiry(input.message, lexicon)) {
          plan = productPlanSchema.parse({
            mode: 'PRODUCT',
            query: input.message,
            ambiguous: true,
          });
        } else {
          const probe = await this.products.probe(scope, input.message);
          const storeFields = await this.products.plannerCatalog(
            scope,
            'th',
            catalog,
          );
          plannedBusinessType = storeFields.businessType;
          const references =
            [...input.recentMessages]
              .reverse()
              .find(
                (m) => m.role === 'assistant' && m.catalogRefs !== undefined,
              )
              ?.catalogRefs?.slice() ?? [];
          const scopedReferences = references.filter(
            (r) => r.companyId === scope.companyId,
          );
          const lastRefs = [
            ...new Set(scopedReferences.map((r) => r.productId)),
          ].slice(-5);
          const exactSku =
            probe.length === 1 &&
            probe[0].skus.some(
              (sku) =>
                input.message.trim().toLowerCase() === sku.toLowerCase() ||
                input.message.toLowerCase().startsWith(`${sku.toLowerCase()} `),
            );

          const said = (list: readonly string[]) =>
            matchesSignals(lexicon, list, input.message);
          const policyWorded = said(lexicon.policySignals);
          const asks: ProductPlan['asks'] = [];
          if (said(lexicon.askSignals.PRICE)) asks.push('PRICE');

          if (said(lexicon.askSignals.STOCK)) asks.push('STOCK');

          if (policyWorded) asks.push('POLICY');

          if (exactSku) {
            plan = productPlanSchema.parse({
              mode: policyWorded ? 'BOTH' : 'PRODUCT',
              query: input.message,
              policyQuery: input.message,
              productIds: [probe[0].id],
              asks,
            });
          } else if (
            policyWorded &&
            !said(lexicon.signals) &&
            !probe.length &&
            !said(lexicon.referenceSignals)
          ) {
            plan = productPlanSchema.parse({
              mode: 'KNOWLEDGE',
              query: input.message,
              asks: ['POLICY'],
            });
          } else {
            this.decisionTrace?.enter('product');
            const planning = await this.turns.call(
              lease,
              'PLAN',
              {
                systemInstruction: buildProductPlannerPrompt({
                  businessType: storeFields.businessType,
                  storeFields: storeFields.fields,
                  catalog: probe,
                  presentedRefs: scopedReferences,
                  presentedProductIds: lastRefs,
                  storeOptions: storeFields.options,
                  storeCategories: storeFields.categories,
                  storeAskFields: storeFields.askable,
                  ...(slots
                    ? {
                        timeContext: plannerTimeContext(
                          this.clock.now(),
                          this.clock.timeZone,
                        ),
                      }
                    : {}),
                }),
                messages: toAiProviderMessages(
                  input.recentMessages,
                  input.message,
                ),
                responseJsonSchema: z.toJSONSchema(plannerSchemaFor(slots)),
                temperature: 0.1,
                maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
                reasoningEffort: 'low',
              },
              context,
            );
            try {
              if (!planning) throw new Error('Planner unavailable');
              plan = productPlanSchema.parse(
                plannerSchemaFor(slots).parse(
                  JSON.parse(stripJsonCodeFence(planning.text.trim())),
                ),
              );
              const allowedIds = new Set([
                ...probe.map((p) => p.id),
                ...lastRefs,
              ]);
              if (plan.productIds.some((id) => !allowedIds.has(id)))
                throw new Error('Unverified planner product ID');
              // Slots may only be ones the customer was already shown.
              const shownSlots = new Set(
                scopedReferences.flatMap((r) => (r.slotId ? [r.slotId] : [])),
              );
              if (plan.slotIds?.some((id) => !shownSlots.has(id)))
                throw new Error('Unverified planner slot ID');
              const allowedVariants = new Set([
                ...probe.flatMap((p) => p.variantIds),
                ...scopedReferences.flatMap((r) =>
                  r.variantId ? [r.variantId] : [],
                ),
              ]);
              if (plan.variantIds.some((id) => !allowedVariants.has(id)))
                throw new Error('Unverified planner variant ID');
              // An invented field would silently match nothing or be ignored.
              const optionKeys = new Set(storeFields.options.map((o) => o.key));
              if (
                [...plan.options.map((o) => o.key), ...plan.listOptions].some(
                  (key) => !optionKeys.has(key),
                )
              )
                throw new Error('Unknown planner option field');
              if (
                plan.filters.some(
                  (filter) =>
                    !storeFields.fields?.some(
                      (field) =>
                        field.key === filter.key &&
                        field.operators.includes(filter.operator),
                    ),
                )
              )
                throw new Error('Unknown planner business field or operator');
              // A chosen value of a variant option ("สีแดง") is an option, not a
              // filter: filtered out it reads as "which product?" instead of
              // "not available in that color".
              const chosen = plan.filters.filter(
                (filter) =>
                  filter.operator === 'EQ' &&
                  optionKeys.has(filter.key) &&
                  typeof filter.value === 'string',
              );
              if (chosen.length) {
                plan.filters = plan.filters.filter((f) => !chosen.includes(f));
                for (const filter of chosen)
                  if (
                    plan.options.length < 6 &&
                    !plan.options.some((o) => o.key === filter.key)
                  )
                    plan.options.push({
                      key: filter.key,
                      value: String(filter.value),
                    });
              }
              // Only fields the store lets the model see; a wrong key is dropped, not the plan.
              plan = groundAskFields(plan, storeFields.askable);
              if (
                plan.minPrice &&
                plan.maxPrice &&
                new Prisma.Decimal(plan.minPrice).gt(
                  new Prisma.Decimal(plan.maxPrice),
                )
              )
                throw new Error('Invalid price range');
              // Explicit catalog references cannot be downgraded to ungrounded general chat by the model.
              if (probe.length && plan.mode === 'GENERAL')
                plan.mode = policyWorded ? 'BOTH' : 'PRODUCT';
              if (!plan.query.trim() && !plan.filters.length)
                plan.query = input.message;
            } catch {
              plan = productPlanSchema.parse({
                mode: 'PRODUCT',
                query: input.message,
                ambiguous: true,
              });
              failed = true;
            }
          }
        }
        if (slots && !failed) {
          const resolved = this.resolveWhen(plan, input.message);
          plan = resolved.plan;
          dateSource = resolved.source;
        }
        plan = groundStockFilter(plan, input.message);
        await this.turns.save(lease, 'plan', {
          plan,
          failed,
          businessType: plannedBusinessType,
          ...(dateSource ? { dateSource } : {}),
        });
      }
      let result: ProductSearchResult = {
        status: 'NO_MATCH',
        evidence: [],
        choices: [],
      };
      let knowledgeResult: KnowledgeRetrievalResult | undefined;
      let embedding: EmbeddingResult | undefined;
      if (!failed && isBroadProductInquiry(input.message, lexicon)) {
        result = { status: 'MISSING_INPUT', evidence: [], choices: [] };
      } else if (!failed && (plan.mode === 'PRODUCT' || plan.mode === 'BOTH')) {
        try {
          result = await this.products.search(
            scope,
            plan,
            undefined,
            'th',
            plannedBusinessType,
          );
          if (
            this.features.productSemanticEnabled &&
            !plan.productIds.length &&
            // A filters-only plan has nothing to embed (an empty text throws).
            plan.query.trim().length > 0 &&
            (['NO_MATCH', 'NO_RELIABLE_CANDIDATE'].includes(result.status) ||
              plan.operation === 'RECOMMEND')
          ) {
            if (input.embeddingModel !== this.embeddings.model)
              throw new ServiceUnavailableException(
                'Pinned product embedding model changed',
              );
            embedding = await this.embeddings.embedQuery(
              plan.query,
              queryContext,
            );
            result = await this.products.search(
              scope,
              plan,
              embedding,
              'th',
              plannedBusinessType,
            );
          }
        } catch (error) {
          rethrowPendingAiUsage(error);
          rethrowInsufficientCredit(error);
          if (result.status !== 'FOUND')
            result = { status: 'UNAVAILABLE', evidence: [], choices: [] };
        }
      }
      this.decisionTrace?.note('product', {
        commerceTurnId: turn.id,
        mode: plan.mode,
        operation: plan.operation,
        asks: plan.asks,
        options: plan.options.map((o) => `${o.key}=${o.value}`),
        filters: plan.filters.map(
          (f) => `${f.key} ${f.operator} ${String(f.value)}`,
        ),
        category: plan.category,
        ambiguous: plan.ambiguous,
        ...(slots
          ? {
              dateSource: dateSource ?? 'NONE',
              when: plan.when
                ? `${plan.when.date ?? '-'} ${plan.when.after ?? ''}-${plan.when.before ?? ''}`
                : null,
              quantity: plan.quantity ?? null,
              slotOutcome: result.slotOutcome ?? null,
            }
          : {}),
        plannerFailed: failed,
        semantic: Boolean(embedding),
        status: result.status,
        identified: result.identified ?? null,
        evidence: result.evidence.length,
        choices: result.choices.length,
        total: result.total ?? null,
      });
      if (!failed && plan.mode === 'KNOWLEDGE') {
        // A store-policy question is the legacy knowledge route's job: DIRECT
        // presets, CLARIFY and conflict handoff stay intact, and no product
        // evidence reaches the model. The planner already classified it, so
        // the router skips its second BUSINESS/GENERAL classifier call.
        const policyQuery = (plan.policyQuery || plan.query).trim();
        const knowledgeOnly: KnowledgeRetrievalResult = {
          ...(policyQuery === input.message.trim()
            ? await legacy()
            : await knowledge(policyQuery)),
          plannerIntent: 'KNOWLEDGE',
        };
        await this.turns.save(lease, 'retrieval', knowledgeOnly);
        return knowledgeOnly;
      }
      if (!failed && plan.mode === 'BOTH') {
        const policyQuery = plan.policyQuery || plan.query;
        knowledgeResult = await knowledge(
          policyQuery,
          policyQuery === plan.query ? embedding : undefined,
          plan.mode === 'BOTH',
        );
      }
      const productItems = result.evidence.map((e) => ({
        source: 'PRODUCT' as const,
        id: e.variantId,
        title: e.name,
        content: e.description,
        answer: JSON.stringify(e),
        score: 1,
      }));
      const selected = [
        ...productItems,
        ...(knowledgeResult?.selectedItems ?? []),
      ];
      const retrieval: KnowledgeRetrievalResult = {
        route: 'RAG',
        matchType: embedding
          ? 'HYBRID'
          : productItems.length
            ? 'EXACT'
            : (knowledgeResult?.matchType ?? 'NONE'),
        items: [...productItems, ...(knowledgeResult?.items ?? [])],
        selectedItems: selected,
        topScores: [],
        scoreGap: null,
        // Product outcome has its own safe clarify/fallback handling, before generic routing.
        product: {
          turnId: turn.id,
          scope,
          plan,
          result,
          failed:
            failed ||
            knowledgeResult?.fallbackReason === 'RETRIEVAL_ERROR' ||
            knowledgeResult?.fallbackReason === 'CONFLICTING_CANDIDATES',
        },
      };
      await this.turns.save(lease, 'retrieval', retrieval);
      return retrieval;
    });
  }

  /**
   * The customer's own day/time words, read by code, win over the model's
   * reading; the model fills only what the words do not say.
   */
  private resolveWhen(
    plan: ProductPlan,
    message: string,
  ): { plan: ProductPlan; source: DateSource } {
    const parsed = parseThaiDateTime(
      message,
      todayIn(this.clock.now(), this.clock.timeZone),
    );
    const model = plan.when ?? null;
    const read = parsed.date || parsed.after || parsed.before;
    const times = parsed.after || parsed.before;
    let when = model;
    let source: DateSource = model ? 'MODEL' : 'NONE';
    if (read) {
      const next = {
        date: parsed.date ?? model?.date ?? null,
        after: times ? parsed.after : (model?.after ?? null),
        before: times ? parsed.before : (model?.before ?? null),
      };
      const differs =
        model !== null &&
        ((parsed.date !== null &&
          model.date !== null &&
          parsed.date !== model.date) ||
          (Boolean(times) &&
            Boolean(model.after || model.before) &&
            (parsed.after !== model.after || parsed.before !== model.before)));
      source = differs ? 'PARSER_OVERRIDE' : 'PARSER';
      when = next;
    }
    // An inverted time window cannot be searched; widen to the whole day.
    if (when?.after && when.before && when.after >= when.before)
      when = { ...when, after: null, before: null };
    if (when && !when.date && !when.after && !when.before) when = null;
    const quantity = parseQuantity(message) ?? plan.quantity ?? null;
    const asks = [...plan.asks];
    if (when && !asks.includes('SCHEDULE') && asks.length < 5)
      asks.push('SCHEDULE');
    return {
      plan: { ...plan, when, quantity, slotIds: plan.slotIds ?? [], asks },
      source,
    };
  }

  /**
   * Routes a new event without spending a planner call when the message has no
   * catalog signal: a confident FAQ hit (or a legacy safety outcome) stays on
   * the legacy route, and a policy-worded question is KNOWLEDGE. Otherwise the
   * planner replaces the legacy BUSINESS/GENERAL classifier.
   */
  private async routeWithoutPlanner(
    scope: CommerceScope,
    message: string,
    history: readonly ChatContextMessage[],
    legacy: LegacyRead,
    catalog: CatalogContext,
  ): Promise<KnowledgeRetrievalResult | undefined | 'PLAN'> {
    const { lexicon } = catalog;
    const hasRefs = history.some(
      (m) =>
        m.role === 'assistant' &&
        m.catalogRefs?.some((r) => r.companyId === scope.companyId),
    );
    if (
      matchesSignals(lexicon, lexicon.signals, message) ||
      (hasRefs && matchesSignals(lexicon, lexicon.referenceSignals, message)) ||
      (await this.products.probe(scope, redactPii(message))).length ||
      (await this.products.mentionsCatalog(
        scope,
        redactPii(message),
        'th',
        catalog,
      ))
    )
      return 'PLAN';
    const base = await legacy();
    if (
      base.route !== 'LOW_CONFIDENCE' ||
      (base.fallbackReason !== undefined &&
        SETTLED_KNOWLEDGE.has(base.fallbackReason))
    )
      return undefined;
    if (matchesSignals(lexicon, lexicon.policySignals, message))
      return { ...base, plannerIntent: 'KNOWLEDGE' };
    return 'PLAN';
  }
}
