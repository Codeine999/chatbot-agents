import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CommerceTurnService } from '../../../commerce/commerce-turn.service';
import type {
  AiRequestContext,
  AiAnswerResult,
  KnowledgeRetrievalResult,
} from '../../types/chat.types';
import type { AiRuntimeSetting } from '../../types/ai-runtime.types';
import { composeAiAnswerPrompt } from '../../prompt/ai-setting-prompt.composer';
import { toAiProviderMessages } from '../../context/ai-provider-context';
import { GENERAL_RULES } from '../../constants/ai-chat.constants';
import { buildProductAnswerPrompt } from './utils/prompt/product-answer-prompt';
import {
  productAnswerSchema,
  productAnswerDecision,
  productPromptEvidence,
  presentedProductRefs,
  renderProductAnswer,
  safeProductAnswer,
  unmatchedProductAnswer,
} from './product-answer.policy';
import type { ProductWorkflow } from '../../../products/search/product-search.types';

// No policy evidence was found for the policy half of a product question.
const POLICY_UNVERIFIED_NOTE =
  'ส่วนเงื่อนไขหรือนโยบายของร้านที่ถาม ยังไม่มีข้อมูลยืนยัน กรุณาสอบถามเจ้าหน้าที่ค่ะ';

@Injectable()
export class ProductAnswerService {
  constructor(private readonly turns: CommerceTurnService) {}

  async answer(
    retrieval: KnowledgeRetrievalResult,
    setting: AiRuntimeSetting,
    context: AiRequestContext,
  ): Promise<AiAnswerResult> {
    const workflow = retrieval.product!;
    return this.turns.withLease(
      workflow.scope,
      workflow.turnId,
      async (lease) => {
        if (lease.turn.response)
          return lease.turn.response as unknown as AiAnswerResult;
        const saved =
          (lease.turn.retrieval as unknown as KnowledgeRetrievalResult) ??
          retrieval;
        const policies = saved.selectedItems.filter(
          (e) => e.source !== 'PRODUCT' && e.answer?.trim(),
        );
        // Answer the grounded product half rather than discarding it; the
        // policy half is stated as unverified, never invented.
        const policyMissing =
          saved.product!.plan.mode === 'BOTH' && !policies.length;
        const product: ProductWorkflow = policyMissing
          ? {
              ...saved.product!,
              plan: {
                ...saved.product!.plan,
                mode: 'PRODUCT',
                asks: saved.product!.plan.asks.filter((a) => a !== 'POLICY'),
              },
            }
          : saved.product!;
        const input = lease.turn.input as unknown as {
          message: string;
          recentMessages: NonNullable<AiRequestContext['recentMessages']>;
        };
        const previousRefs = [...input.recentMessages]
          .reverse()
          .find(
            (m) => m.role === 'assistant' && m.catalogRefs !== undefined,
          )?.catalogRefs;
        let answer: AiAnswerResult;
        if (
          product.failed ||
          (product.plan.mode === 'KNOWLEDGE' && !policies.length)
        ) {
          answer = { text: setting.fallbackMessage, isFallback: true };
        } else if (
          product.plan.mode !== 'GENERAL' &&
          product.plan.mode !== 'KNOWLEDGE' &&
          product.result.status !== 'FOUND'
        ) {
          answer = {
            text:
              safeProductAnswer(product, policies) +
              (policyMissing ? `\n${POLICY_UNVERIFIED_NOTE}` : ''),
            isFallback: product.result.status === 'UNAVAILABLE',
          };
        } else {
          const general = product.plan.mode === 'GENERAL';
          const rules = general
            ? GENERAL_RULES
            : buildProductAnswerPrompt(product.result.businessType);
          const { policies: policyEvidence, ...productEvidence } =
            productPromptEvidence(product, policies);
          const request = {
            systemInstruction: composeAiAnswerPrompt({
              setting,
              modeRules: rules,
              // Evidence is data, escaped and listed once; it is not part of the rules.
              dataSections: general
                ? undefined
                : {
                    question: {
                      mode: product.plan.mode,
                      operation: product.plan.operation,
                      asks: product.plan.asks,
                      options: product.plan.options,
                      filters: product.plan.filters,
                      listOptions: product.plan.listOptions,
                      countUnit: product.plan.countUnit,
                    },
                    productEvidence,
                    policyEvidence,
                  },
            }),
            messages: toAiProviderMessages(input.recentMessages, input.message),
            temperature: general ? 0.4 : 0.2,
            maxOutputTokens: 1800,
            reasoningEffort: 'low' as const,
            ...(!general
              ? { responseJsonSchema: z.toJSONSchema(productAnswerSchema) }
              : {}),
          };
          const response = await this.turns.call(
            lease,
            'ANSWER',
            request,
            context,
          );
          let text = general
            ? response?.text.trim()
            : response
              ? renderProductAnswer(response.text, product, policies)
              : undefined;
          let presentedRaw = text && !general ? response?.text : undefined;
          // An explicit "this evidence does not answer it" is a judgment, not a
          // format failure: no repair call, and no fact listing as the answer.
          const rejected =
            !general &&
            !!response &&
            productAnswerDecision(response.text) === 'INSUFFICIENT_CONTEXT';
          // Third call is reserved for important grounded corrections, never provider retries or casual chat.
          const critical =
            !general &&
            (product.plan.mode === 'BOTH' ||
              product.plan.operation === 'COMPARE' ||
              (product.plan.asks.includes('PRICE') &&
                product.plan.asks.includes('STOCK')));
          if (!text && response && critical && !rejected) {
            const repaired = await this.turns.call(
              lease,
              'CRITICAL_REPAIR',
              {
                ...request,
                systemInstruction:
                  request.systemInstruction +
                  '\nคำตอบก่อนหน้าไม่ผ่านการตรวจ facts/coverage ให้สร้างใหม่จากหลักฐานเดิม ใช้เฉพาะ allowlisted tokens และตอบครบทุกส่วน ห้ามสร้างข้อมูลใหม่',
              },
              context,
              true,
            );
            if (repaired) {
              text = renderProductAnswer(repaired.text, product, policies);
              presentedRaw = text ? repaired.text : undefined;
            }
          }
          if (rejected && !text) {
            // A named product the catalog cannot answer about goes to staff;
            // rejected search candidates are offered by name for the customer to pick.
            const unmatched = unmatchedProductAnswer(product);
            answer =
              product.result.identified || !unmatched.catalogRefs.length
                ? { text: setting.fallbackMessage, isFallback: true }
                : {
                    text:
                      unmatched.text +
                      (policyMissing ? `\n${POLICY_UNVERIFIED_NOTE}` : ''),
                    isFallback: false,
                    catalogRefs: unmatched.catalogRefs,
                  };
            await this.turns.save(lease, 'response', answer);
            return answer;
          }
          if (!text && !general && product.plan.mode !== 'KNOWLEDGE')
            text = safeProductAnswer(product, policies);
          if (text && policyMissing)
            text = `${text}\n${POLICY_UNVERIFIED_NOTE}`;
          answer = {
            text: text || setting.fallbackMessage,
            isFallback: !text,
            ...(text && !general
              ? {
                  catalogRefs: presentedRaw
                    ? presentedProductRefs(presentedRaw, product)
                    : (product.plan.operation === 'COUNT'
                        ? []
                        : product.result.evidence.slice(0, 5)
                      ).map((e) => ({
                        companyId: product.scope.companyId,
                        productId: e.productId,
                        variantId: e.variantId,
                      })),
                }
              : {}),
          };
        }
        // Clarification choices are also retained only after accepted delivery.
        if (!answer.isFallback && product.result.choices.length)
          answer = {
            ...answer,
            catalogRefs: product.result.choices.map((e) => ({
              companyId: product.scope.companyId,
              productId: e.id,
            })),
          };
        if (
          !answer.isFallback &&
          product.plan.mode === 'KNOWLEDGE' &&
          previousRefs
        )
          answer = { ...answer, catalogRefs: previousRefs };
        if (!answer.isFallback && product.plan.mode === 'GENERAL')
          answer = { ...answer, catalogRefs: [] };
        await this.turns.save(lease, 'response', answer);
        return answer;
      },
    );
  }
}
