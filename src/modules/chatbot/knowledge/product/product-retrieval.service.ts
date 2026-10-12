import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { CommerceFeatureService } from '../../../commerce/commerce-feature.service';
import { CommerceScopeService } from '../../../commerce/commerce-scope.service';
import { CommerceTurnService } from '../../../commerce/commerce-turn.service';
import { buildProductPlannerPrompt } from './utils/prompt/product-prompt';
import { ProductSearchService } from '../../../products/search/product-search.service';
import { groundStockFilter } from '../../../products/search/product-plan-policy';
import {
  productPlanSchema,
  productPlannerSchema,
  type ProductPlan,
  type ProductSearchResult,
} from '../../../products/search/product-search.types';
import { EmbeddingService } from '../../../ai/embeding/embedding.service';
import type { EmbeddingResult } from '../../../../infra/embedding/embedding-adapter.interface';
import type {
  AiRequestContext,
  KnowledgeRetrievalResult,
  ChatContextMessage,
} from '../../types/chat.types';
import { toAiProviderMessages } from '../../context/ai-provider-context';
import { redactPii } from '../../../../utils/text.utils';
import { stripJsonCodeFence } from '../../../../utils/json.utils';
import { rethrowPendingAiUsage } from '../../../usage/billing/pending-ai-usage.error';
import { Prisma, type CommerceTurn } from '../../../../generated/prisma/client';
import type { CommerceScope } from '../../../commerce/types/commerce-scope';

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
const policySignal =
  /(ส่งฟรี|ค่าส่ง|จัดส่ง|คืนสินค้า|รับประกัน|วิธีสมัคร|นโยบาย|shipping|return policy)/iu;
const productSignal =
  /(ราคา|สินค้า|รุ่น|สี|ไซ[ซส]|ขนาด|สต็อก|มีของ|ซื้อ|อยากได้|แนะนำ|เสื้อ|รองเท้า|stock|product|sku)/iu;
/** Whole-message catalog opener; named products and list requests keep normal search. */
export function isBroadProductInquiry(message: string): boolean {
  return /^(?:ขอ|อยาก|ต้องการ)?(?:สอบถาม|ถาม|สนใจ)(?:เกี่ยวกับ|เรื่อง)?สินค้า(?:หน่อย)?(?:ครับ|ค่ะ|คะ|คับ)?[?？!]*$/u.test(
    message.replace(/\s+/gu, ''),
  );
}

const referenceSignal =
  /(ตัวนี้|ตัวนั้น|เมื่อกี้|อันนี้|อันนั้น|ตัวแรก|ตัวที่|สีดำ|สีขาว|แล้ว.*(?:ราคา|สี|ไซ))/u;
// Legacy outcomes the router already handles safely without a product planner.
const SETTLED_KNOWLEDGE = new Set([
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
  ) {}

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
    if (
      !this.features.productRagEnabled ||
      !context.userId ||
      !context.turnId ||
      !context.lineMemberId ||
      !context.conversationId
    )
      return undefined;
    // Whole-message policy questions keep the legacy cache/DIRECT route and never pay for a Product planner.
    if (
      /^(?:ส่งฟรีไหม|ค่าส่งเท่าไร|ค่าส่งเท่าไหร่|จัดส่งกี่วัน|คืนสินค้าได้ไหม|มีรับประกันไหม)(?:ครับ|ค่ะ|คะ|คับ)?[?？]*$/u.test(
        message.replace(/\s+/gu, ''),
      )
    )
      return undefined;

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

    const history = (context.recentMessages ?? [])
      .slice(-6)
      .filter((m) => m.source !== 'REGISTRATION')
      .map((m) => ({ ...m, text: redactPii(m.text).slice(0, 1000) }));

    let turn: CommerceTurn | null;
    try {
      turn = await this.turns.find(
        scope,
        this.features.lineConnectionKey,
        context,
      );

      if (!turn) {
        const routed = await this.routeWithoutPlanner(
          scope,
          message,
          history,
          legacy,
        );
        if (routed !== 'PLAN') return routed;
      }

      turn ??= await this.turns.open(
        scope,
        this.features.lineConnectionKey,
        context,
        {
          message: redactPii(message),
          recentMessages: history,
          embeddingModel: this.embeddings.model,
        },
      );
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

      if (lease.turn.plan) {
        const stored = lease.turn.plan as unknown as {
          plan: ProductPlan;
          failed: boolean;
          businessType?: string | null;
        };

        plan = productPlanSchema.parse(stored.plan);
        failed = stored.failed;
        plannedBusinessType = stored.businessType;
      } else {
        if (isBroadProductInquiry(input.message)) {
          plan = productPlanSchema.parse({
            mode: 'PRODUCT',
            query: input.message,
            ambiguous: true,
          });
        } else {
          const probe = await this.products.probe(scope, input.message);
          const storeFields = await this.products.plannerCatalog(scope);
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

          const asks: ProductPlan['asks'] = [];
          if (/ราคา|เท่าไร|เท่าไหร่|price/iu.test(input.message))
            asks.push('PRICE');

          if (/มีของ|สต็อก|พร้อมส่ง|หมด|เหลือ|stock/iu.test(input.message))
            asks.push('STOCK');

          if (policySignal.test(input.message)) asks.push('POLICY');

          if (exactSku) {
            plan = productPlanSchema.parse({
              mode: policySignal.test(input.message) ? 'BOTH' : 'PRODUCT',
              query: input.message,
              policyQuery: input.message,
              productIds: [probe[0].id],
              asks,
            });
          } else if (
            policySignal.test(input.message) &&
            !productSignal.test(input.message) &&
            !probe.length &&
            !referenceSignal.test(input.message)
          ) {
            plan = productPlanSchema.parse({
              mode: 'KNOWLEDGE',
              query: input.message,
              asks: ['POLICY'],
            });
          } else {
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
                }),
                messages: toAiProviderMessages(
                  input.recentMessages,
                  input.message,
                ),
                responseJsonSchema: z.toJSONSchema(productPlannerSchema),
                temperature: 0.1,
                maxOutputTokens: 900,
                reasoningEffort: 'low',
              },
              context,
            );
            try {
              if (!planning) throw new Error('Planner unavailable');
              plan = productPlannerSchema.parse(
                JSON.parse(stripJsonCodeFence(planning.text.trim())),
              );
              const allowedIds = new Set([
                ...probe.map((p) => p.id),
                ...lastRefs,
              ]);
              if (plan.productIds.some((id) => !allowedIds.has(id)))
                throw new Error('Unverified planner product ID');
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
                plan.mode = policySignal.test(input.message)
                  ? 'BOTH'
                  : 'PRODUCT';
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
        plan = groundStockFilter(plan, input.message);
        await this.turns.save(lease, 'plan', {
          plan,
          failed,
          businessType: plannedBusinessType,
        });
      }
      let result: ProductSearchResult = {
        status: 'NO_MATCH',
        evidence: [],
        choices: [],
      };
      let knowledgeResult: KnowledgeRetrievalResult | undefined;
      let embedding: EmbeddingResult | undefined;
      if (!failed && isBroadProductInquiry(input.message)) {
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
          if (result.status !== 'FOUND')
            result = { status: 'UNAVAILABLE', evidence: [], choices: [] };
        }
      }
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
  ): Promise<KnowledgeRetrievalResult | undefined | 'PLAN'> {
    const hasRefs = history.some(
      (m) =>
        m.role === 'assistant' &&
        m.catalogRefs?.some((r) => r.companyId === scope.companyId),
    );
    if (
      productSignal.test(message) ||
      (hasRefs && referenceSignal.test(message)) ||
      (await this.products.probe(scope, redactPii(message))).length ||
      (await this.products.mentionsCatalog(scope, redactPii(message)))
    )
      return 'PLAN';
    const base = await legacy();
    if (
      base.route !== 'LOW_CONFIDENCE' ||
      SETTLED_KNOWLEDGE.has(base.fallbackReason ?? '')
    )
      return undefined;
    if (policySignal.test(message))
      return { ...base, plannerIntent: 'KNOWLEDGE' };
    return 'PLAN';
  }
}
