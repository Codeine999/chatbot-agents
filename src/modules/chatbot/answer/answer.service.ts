import { rethrowPendingAiUsage } from '../../usage/billing/pending-ai-usage.error';
import { rethrowInsufficientCredit } from '../../usage/credit-point/insufficient-credit.exception';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_GENERATION_CONFIG } from '../../../ai-provider/utils/ai-provider.config';
import { UsersAiProviderService } from '../../ai/users-ai-provider.service';
import type {
  AiProviderImage,
  AiProviderMessage,
} from '../../../ai-provider/types/ai-provider.types';
import { AiBudgetService } from '../../usage/rate-limit/ai-budget.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KnowledgeRetrievalService } from '../../knowledge/knowledge-retrieval.service';
import { toAiProviderMessages } from '../../ai/prompt/ai-provider-context';
import {
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_SYSTEM_PROMPT,
  GENERAL_RULES,
  PARTIAL_ANSWER_NOTE,
} from '../../ai/prompt/ai-chat.constants';
import { INSUFFICIENT_CONTEXT } from '../../../shared/knowledge/knowledge-routing.constants';
import {
  AiAnswerResult,
  AiRequestContext,
  KnowledgeAnswerContext,
  KnowledgeItem,
} from '../../../shared/contracts/chat.types';
import { AiRuntimeSetting } from '../../ai/prompt/ai-runtime.types';
import { logBlock, logSafeText } from '../../../utils/text.utils';
import {
  isSafeImageAnalysis,
  parseImageAnalysisResponse,
} from '../intent/utils/image-analysis.policy';
import {
  aiSettingTenantId,
  parseAiResponseStyle,
  aiResponseStyleSchema,
  parseAiSkills,
} from '../../ai/ai-setting/ai-setting-config';
import { composeAiAnswerPrompt } from '../../ai/prompt/ai-setting-prompt.composer';
import { isUsableKnowledge } from '../../knowledge/utils/knowledge-answer.policy';
import { ProductAnswerService } from '../../products/rag/product-answer.service';
import { isHandoffAnchor } from '../intent/utils/route-stages';
import type { PoliteParticle } from '../../../shared/templates/answer-template.service';
import { IMAGE_ANSWER_RULES } from './image/image-answer.rules';
import {
  GROUNDED_JSON_SCHEMA,
  groundedResponseSchema,
  type GroundedResponse,
} from './grounded/grounded-response.schema';
import { buildKnowledgeSystemInstruction } from './grounded/knowledge-instruction';
import { DecisionTraceService } from '../../decision-log/decision-trace.service';

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly tenantId: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
    private readonly aiBudgetService: AiBudgetService,
    private readonly usersAiProviderService: UsersAiProviderService,
    config: ConfigService,
    @Optional() private readonly productAnswers?: ProductAnswerService,
    @Optional() private readonly decisionTrace?: DecisionTraceService,
  ) {
    this.tenantId = aiSettingTenantId(config);
  }

  async answerKnowledge(
    message: string,
    context: KnowledgeAnswerContext = {},
  ): Promise<AiAnswerResult> {
    const retrievalQuery = context.retrievalQuery?.trim() || message;
    const retrieval =
      context.retrieval ??
      (await this.knowledgeRetrievalService.retrieve(retrievalQuery, {
        userId: context.userId,
        lineMemberId: context.lineMemberId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        recentMessages: context.recentMessages,
      }));

    if (retrieval.product && this.productAnswers) {
      return this.productAnswers.answer(
        retrieval,
        await this.getActiveAiSetting(),
        context,
      );
    }

    if (
      retrieval.route === 'DIRECT' &&
      retrieval.selectedItems[0]?.source === 'ANSWER_PATTERN' &&
      isUsableKnowledge(retrieval.selectedItems[0]) &&
      retrieval.selectedItems[0]?.metadata?.safeDirect === true &&
      retrieval.selectedItems[0]?.renderMode !== 'REWRITE'
    ) {
      const direct = retrieval.selectedItems[0]?.answer?.trim();
      if (direct) {
        this.logger.debug(
          logBlock('Answer', [
            'mode=DIRECT preset (no model call)',
            `evidence=${retrieval.selectedItems[0].source}:${retrieval.selectedItems[0].id}`,
          ]),
        );
        this.decisionTrace?.answer({
          mode: 'DIRECT_PRESET',
          evidenceIds: [
            `${retrieval.selectedItems[0].source}:${retrieval.selectedItems[0].id}`,
          ],
        });
        return { text: direct, isFallback: false };
      }
    }

    const setting = await this.getActiveAiSetting();

    // Handoff anchors only route; their text claims an action the system
    // would not have taken, so the model must never see or paraphrase it.
    const usableItems = retrieval.selectedItems.filter(
      (item) => isUsableKnowledge(item) && !isHandoffAnchor(item),
    );
    if (usableItems.length > 0) {
      return this.generateFromKnowledge(usableItems, message, setting, context);
    }

    this.logger.debug(
      logBlock('Answer', [
        'mode=FALLBACK (no usable evidence)',
        `fallback=${retrieval.fallbackReason ?? '-'}`,
      ]),
    );
    this.decisionTrace?.answer({
      mode: 'FALLBACK',
      fallbackReason: retrieval.fallbackReason ?? 'NO_USABLE_EVIDENCE',
    });
    return { text: setting.fallbackMessage, isFallback: true };
  }

  /**
   * General / small-talk answer. Use for casual chat.
   * Never touches the knowledge base and never claims business status.
   */
  async answerGeneral(
    message: string,
    context: AiRequestContext = {},
  ): Promise<AiAnswerResult> {
    const setting = await this.getActiveAiSetting();

    const messages = toAiProviderMessages(
      context.recentMessages ?? [],
      message,
    );
    const systemInstruction = composeAiAnswerPrompt({
      setting,
      ragContext: [],
      modeRules: GENERAL_RULES,
    });

    return this.generateText(
      messages,
      systemInstruction,
      setting.fallbackMessage,
      context,
    );
  }

  /** The particle the assistant keeps in canned replies, from the active setting. */
  async politeParticle(): Promise<PoliteParticle> {
    return (await this.getActiveAiSetting()).responseStyle.politeParticle;
  }

  /** Return the configured fallback literally; never call an AI provider. */
  async answerFallback(): Promise<AiAnswerResult> {
    const { fallbackMessage } = await this.getActiveAiSetting();
    return { text: fallbackMessage, isFallback: true };
  }

  async answerImage(
    image: AiProviderImage,
    context: AiRequestContext = {},
  ): Promise<AiAnswerResult> {
    const setting = await this.getActiveAiSetting();

    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      this.fallback('AI_BUDGET_EXHAUSTED');
      return { text: setting.fallbackMessage, isFallback: true };
    }

    try {
      const messages = toAiProviderMessages(
        context.recentMessages ?? [],
        'วิเคราะห์รูปภาพที่ผู้ใช้แนบตามกฎความปลอดภัย',
      );
      const historyMessages = messages.slice(0, -1);
      const currentMessage =
        messages.at(-1)?.text ?? 'วิเคราะห์รูปภาพที่ผู้ใช้แนบตามกฎความปลอดภัย';
      const providerMessages: AiProviderMessage[] = [
        ...historyMessages,
        { role: 'user', text: currentMessage, images: [image] },
      ];
      const response = await this.usersAiProviderService.generate(
        {
          systemInstruction: composeAiAnswerPrompt({
            setting,
            ragContext: [],
            modeRules: IMAGE_ANSWER_RULES,
          }),
          messages: providerMessages,
          temperature: 0.4,
          maxOutputTokens: AI_GENERATION_CONFIG.maxOutputTokens,
          reasoningEffort: 'low',
        },
        context,
      );
      const analysis = parseImageAnalysisResponse(response.text);

      if (!analysis || !isSafeImageAnalysis(analysis)) {
        this.logger.debug(
          `image answer blocked classification=${analysis?.classification ?? 'INVALID'}`,
        );
        this.fallback(
          analysis
            ? `IMAGE_BLOCKED_${analysis.classification}`
            : 'IMAGE_INVALID_OUTPUT',
        );
        return { text: setting.fallbackMessage, isFallback: true };
      }

      this.decisionTrace?.answer({ mode: 'IMAGE' });
      return { text: analysis.answer, isFallback: false };
    } catch (error) {
      rethrowPendingAiUsage(error);
      rethrowInsufficientCredit(error);
      this.logger.error('AI image analysis failed', error as Error);
      this.fallback('PROVIDER_ERROR');
      return { text: setting.fallbackMessage, isFallback: true };
    }
  }

  // --- private helpers ------------------------------------------------------

  private fallback(reason: string): void {
    this.decisionTrace?.answer({ mode: 'FALLBACK', fallbackReason: reason });
  }

  /** Load the active AiSetting, resolving to safe defaults on miss/error. */
  private async getActiveAiSetting(): Promise<AiRuntimeSetting> {
    try {
      const setting = await this.prisma.aiSetting.findFirst({
        where: { active: true, tenantId: this.tenantId },
        orderBy: { updatedAt: 'desc' },
        select: {
          systemPrompt: true,
          ownerPrompt: true,
          tone: true,
          skills: true,
          responseStyle: true,
          promptVersion: true,
          fallbackMessage: true,
        },
      });

      if (
        setting &&
        !aiResponseStyleSchema.safeParse(setting.responseStyle).success
      ) {
        this.logger.warn(
          'AiSetting.responseStyle is invalid; using default style. Configure targetLength=short|medium|adaptive and emojiLevel=none|light|normal.',
        );
      }
      return {
        systemPrompt: setting?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
        ownerPrompt: setting?.ownerPrompt?.trim() || undefined,
        tone: setting?.tone?.trim() || undefined,
        skills: parseAiSkills(setting?.skills),
        responseStyle: parseAiResponseStyle(setting?.responseStyle),
        promptVersion: setting?.promptVersion ?? 1,
        fallbackMessage:
          setting?.fallbackMessage?.trim() || DEFAULT_FALLBACK_MESSAGE,
      };
    } catch (error) {
      rethrowPendingAiUsage(error);
      this.logger.error(
        'failed to load AiSetting, using defaults',
        error as Error,
      );
      return {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        skills: [],
        responseStyle: parseAiResponseStyle(undefined),
        promptVersion: 1,
        fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
      };
    }
  }

  /** Generate text and return the fallback on empty/error. */
  private async generateText(
    messages: readonly AiProviderMessage[],
    systemInstruction: string,
    fallbackMessage: string,
    context: AiRequestContext,
  ): Promise<AiAnswerResult> {
    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      this.fallback('AI_BUDGET_EXHAUSTED');
      return { text: fallbackMessage, isFallback: true };
    }

    try {
      const response = await this.usersAiProviderService.generate(
        {
          messages,
          systemInstruction,
          temperature: 0.4,
          maxOutputTokens: AI_GENERATION_CONFIG.maxOutputTokens,
          reasoningEffort: 'low',
        },
        context,
      );
      const text = response.text.trim();
      if (response.finishReason === 'length')
        this.logger.warn(
          '[Answer] general answer hit the output token cap; the reply may be cut off',
        );
      if (!text) this.fallback('EMPTY_GENERAL_ANSWER');
      else this.decisionTrace?.answer({ mode: 'GENERAL' });
      return text
        ? { text, isFallback: false }
        : { text: fallbackMessage, isFallback: true };
    } catch (error) {
      rethrowPendingAiUsage(error);
      rethrowInsufficientCredit(error);
      this.logger.error('AI generation failed', error as Error);
      this.fallback('PROVIDER_ERROR');
      return { text: fallbackMessage, isFallback: true };
    }
  }

  /** Provider answer grounded strictly on the given knowledge items. */
  private async generateFromKnowledge(
    items: KnowledgeItem[],
    message: string,
    setting: AiRuntimeSetting,
    context: KnowledgeAnswerContext,
  ): Promise<AiAnswerResult> {
    const allowGeneralExit = context.allowGeneralExit === true;
    const messages = toAiProviderMessages(
      context.recentMessages ?? [],
      message,
    );
    const systemInstruction = buildKnowledgeSystemInstruction({
      setting,
      items,
      allowGeneralExit,
    });

    this.logger.debug(
      logBlock('Answer', [
        'mode=GROUNDED generation',
        `items=${items.length}`,
        `history=${messages.length - 1}`,
        `systemCharacters=${systemInstruction.length}`,
        `evidence=${items
          .map((item) => `${item.source}:${item.id}`)
          .join('\n            ')}`,
      ]),
    );

    if (!(await this.aiBudgetService.tryConsume(context.userId))) {
      this.logger.warn(
        '[Answer] AI budget exhausted before grounded generation; using fallback',
      );
      this.fallback('AI_BUDGET_EXHAUSTED');
      return { text: setting.fallbackMessage, isFallback: true };
    }

    try {
      const response = await this.usersAiProviderService.generate(
        {
          messages,
          systemInstruction,
          temperature: 0.2,
          responseJsonSchema: GROUNDED_JSON_SCHEMA,
          maxOutputTokens: AI_GENERATION_CONFIG.maxOutputTokens,
          reasoningEffort: 'medium',
        },
        context,
      );
      const raw = response.text.trim();
      let parsed: GroundedResponse | undefined;
      try {
        parsed = groundedResponseSchema.parse(
          JSON.parse(
            raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
          ),
        );
      } catch {
        // Malformed output is not evidence of answerability.
      }
      // A chance vector hit can route small talk here without the classifier.
      // Only then may the model send it to general chat instead of staff.
      if (parsed?.decision === 'NOT_BUSINESS' && allowGeneralExit) {
        this.logger.debug(
          logBlock('Answer', [
            'mode=GROUNDED -> GENERAL (not a business question)',
          ]),
        );
        this.decisionTrace?.note('answer', {
          generalExit: true,
          askedAbout: parsed.askedAbout ?? null,
        });
        const general = await this.answerGeneral(message, context);
        return { ...general, general: true };
      }

      // Canonical `SOURCE:ID` for every reference the model may cite.
      const refs = new Map<string, string>(
        items.map((item) => [
          `${item.source}:${item.id}`,
          `${item.source}:${item.id}`,
        ]),
      );
      // Some providers copy the bare `id` instead of `ref`. Accept it only
      // when it identifies exactly one selected item; never search the KB or
      // accept a wrong source prefix to repair a model citation.
      for (const item of items) {
        if (
          items.filter((candidate) => candidate.id === item.id).length === 1
        ) {
          refs.set(item.id, `${item.source}:${item.id}`);
        }
      }
      // One mistyped citation must not discard an answer the rest supports:
      // unknown IDs are dropped, and at least one known ID must remain.
      const citedIds =
        parsed?.decision === 'ANSWER'
          ? [...new Set(parsed.evidenceIds.flatMap((id) => refs.get(id) ?? []))]
          : [];

      if (
        parsed?.decision !== 'ANSWER' ||
        parsed.directlyAnswered !== true ||
        citedIds.length === 0 ||
        parsed.answer === INSUFFICIENT_CONTEXT
      ) {
        const reason = !parsed
          ? response.finishReason === 'length'
            ? 'TRUNCATED_OUTPUT'
            : 'INVALID_GROUNDED_OUTPUT'
          : parsed.decision === 'NOT_BUSINESS'
            ? 'NOT_BUSINESS_ON_BUSINESS_ROUTE'
            : parsed.decision !== 'ANSWER' ||
                parsed.answer === INSUFFICIENT_CONTEXT
              ? INSUFFICIENT_CONTEXT
              : parsed.directlyAnswered !== true
                ? 'NOT_DIRECTLY_ANSWERED'
                : 'INVALID_EVIDENCE_REFERENCE';
        this.decisionTrace?.answer({
          mode: 'FALLBACK',
          fallbackReason: reason,
          evidenceIds: items.map((item) => `${item.source}:${item.id}`),
          ...(parsed?.askedAbout ? { askedAbout: parsed.askedAbout } : {}),
        });
        this.logger.debug(
          logBlock('Answer', [
            'mode=FALLBACK',
            `reason=${reason}`,
            parsed?.askedAbout
              ? `askedAbout=${JSON.stringify(logSafeText(parsed.askedAbout))}`
              : null,
          ]),
        );
        return {
          text: setting.fallbackMessage,
          isFallback: true,
        };
      }

      const unanswered = (parsed.unanswered ?? [])
        .map((question) => question.trim())
        .filter(Boolean)
        .slice(0, 3);
      const dropped = parsed.evidenceIds.length - citedIds.length;
      const partial = unanswered.length > 0;
      const text = partial
        ? `${parsed.answer.trim()}\n\n${PARTIAL_ANSWER_NOTE}`
        : parsed.answer.trim();
      this.logger.debug(
        logBlock('Answer', [
          `mode=${partial ? 'GROUNDED_PARTIAL' : 'GROUNDED'} reply`,
          `length=${text.length}`,
          dropped ? `droppedEvidenceIds=${dropped}` : null,
        ]),
      );
      this.decisionTrace?.answer({
        mode: partial ? 'GROUNDED_PARTIAL' : 'GROUNDED',
        evidenceIds: citedIds,
        ...(parsed.askedAbout ? { askedAbout: parsed.askedAbout } : {}),
      });
      if (dropped || partial)
        this.decisionTrace?.note('answer', {
          droppedEvidenceIds: dropped,
          unanswered,
        });
      return { text, isFallback: false, ...(partial ? { handoff: true } : {}) };
    } catch (error) {
      rethrowPendingAiUsage(error);
      rethrowInsufficientCredit(error);
      this.logger.error('RAG answer generation failed', error as Error);
      this.fallback('PROVIDER_ERROR');
      return { text: setting.fallbackMessage, isFallback: true };
    }
  }
}
