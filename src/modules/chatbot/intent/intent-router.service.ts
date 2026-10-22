import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from '../../users/session/user-session.service';
import { RuleIntentService } from './rule-intent.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';

import { RichMenuReplyCacheService } from '../menu/rich-menu-reply-cache.service';
import { parseMenuPostback } from '../../../shared/richMenu/menu-postback';
import {
  ChatContextMessage,
  KnowledgeRetrievalResult,
  RetrievalFallbackReason,
  RouteDecision,
} from '../shared/types/chat.types';
import { fromRule } from './utils/intent.utils';
import { logBlock, logSafeText } from '../../../utils/text.utils';
import type { LineAiUsageContext } from '../../usage/billing/ai-usage.types';
import { decideFromRetrieval, gateBeforeSearch } from './utils/route-stages';

/** Enough of the ranking curve to see a tie; [Retrieval] holds the full list. */
const MAX_LOGGED_SCORES = 5;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);
  constructor(
    private readonly ruleIntentService: RuleIntentService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
    private readonly aiIntentClassifierService: AiIntentClassifierService,
    private readonly richMenuReplies: RichMenuReplyCacheService,
  ) {}

  async resolve(
    params: LineAiUsageContext & {
      userId: string;
      input: string;
      session: ConversationSession | undefined;
      recentMessages?: readonly ChatContextMessage[];
      postbackData?: string;
    },
  ): Promise<RouteDecision> {
    const {
      userId,
      input,
      session,
      recentMessages = [],
      lineMemberId,
      conversationId,
      turnId,
      postbackData,
    } = params;

    this.logger.debug(
      logBlock('Session', [
        `flow=${session?.flow ?? 'none'}`,
        `step=${session?.step ?? 'none'}`,
        `status=${session?.status ?? 'none'}`,
      ]),
    );

    // 1. Menu taps are tenant-configured and outrank text rules.
    const menuDecision = this.resolveRichMenu(postbackData, input);
    if (menuDecision) return this.logDecision(input, menuDecision);

    // 2. Deterministic gates: decide now, or search (maybe with a rule label).
    const rule = this.ruleIntentService.detect(input);
    this.logger.debug(
      logBlock('Rule', [
        `intent=${rule.intent}`,
        `confidence=${rule.confidence}`,
        `source=${rule.source}`,
        `reason=${JSON.stringify(rule.reason ?? '')}`,
      ]),
    );

    const inRegister =
      session?.status === 'ACTIVE' && session.flow === 'REGISTER';
    const gate = gateBeforeSearch({ input, rule, inRegister });
    if (gate.kind === 'DECIDE') return this.logDecision(input, gate.decision);

    // 3. Retrieval owns cache -> DB -> embedding.
    const retrieval = await this.knowledgeRetrievalService.retrieve(input, {
      userId,
      lineMemberId,
      conversationId,
      turnId,
      recentMessages,
      disableProduct: inRegister,
    });

    const decision = decideFromRetrieval(retrieval, input, gate.label);
    if (decision) return this.logDecision(input, decision, retrieval);

    // 4. Low confidence: the classifier decides BUSINESS vs GENERAL.
    return this.resolveLowConfidence({
      userId,
      lineMemberId,
      conversationId,
      turnId,
      input,
      recentMessages,
      retrieval,
      fallbackReason: retrieval.fallbackReason,
    });
  }

  async resolveLowConfidence(
    params: LineAiUsageContext & {
      userId: string;
      input: string;
      recentMessages?: readonly ChatContextMessage[];
      retrieval?: KnowledgeRetrievalResult;
      fallbackReason?: RetrievalFallbackReason;
    },
  ): Promise<RouteDecision> {
    const {
      userId,
      input,
      recentMessages = [],
      retrieval,
      fallbackReason,
      lineMemberId,
      conversationId,
      turnId,
    } = params;
    const analysis = await this.aiIntentClassifierService.classifyLowConfidence(
      input,
      {
        userId,
        lineMemberId,
        conversationId,
        turnId,
        recentMessages,
      },
    );

    if (analysis.classification === 'GENERAL') {
      return this.logDecision(
        input,
        {
          action: 'GENERAL_QUESTION',
          intent: 'GENERAL_QUESTION',
          confidence: analysis.confidence,
          source: 'AI',
          reason: 'low-confidence retrieval classified as GENERAL',
          fallbackReason,
        },
        retrieval,
      );
    }

    // Low-confidence candidates do not prove a business question, but once the
    // classifier says BUSINESS they still ground the answer (paraphrases whose
    // vocabulary differs from the stored knowledge).
    if (retrieval?.selectedItems.length && !analysis.failed) {
      return this.logDecision(
        input,
        {
          action: 'ANSWER_KNOWLEDGE',
          intent: 'ANSWER_KNOWLEDGE',
          confidence: analysis.confidence,
          source: 'AI',
          reason: 'low-confidence candidates classified as BUSINESS',
          resolvedQuery: input,
          retrieval,
        },
        retrieval,
      );
    }

    return this.logDecision(
      input,
      {
        action: 'CONTACT_ADMIN',
        intent: 'CONTACT_ADMIN',
        confidence: analysis.confidence,
        source: 'AI',
        reason: 'low-confidence retrieval classified as BUSINESS',
        businessFallback: true,
        fallbackReason,
      },
      retrieval,
    );
  }

  private resolveRichMenu(
    postbackData: string | undefined,
    input: string,
  ): RouteDecision | null {
    if (postbackData) {
      const parsed = parseMenuPostback(postbackData);

      if (parsed?.kind === 'intent') {
        return {
          ...fromRule({
            intent: parsed.intent,
            confidence: 1,
            source: 'RULE',
            reason: 'rich menu postback',
          }),
          source: 'RULE',
        };
      }

      if (parsed?.kind === 'reply') {
        const match = this.richMenuReplies.byKey(parsed.key);

        if (match) {
          return {
            action: 'RICH_MENU_REPLY',
            intent: 'RICH_MENU_REPLY',
            confidence: 1,
            source: 'DATABASE',
            reason: `rich menu key ${match.key}`,
            richMenuReply: match,
          };
        }

        this.logger.warn(
          logBlock('RichMenu', [
            `key=${parsed.key}`,
            'result=no active reply; falling through to normal routing',
          ]),
        );
      }
    }

    const byLabel = this.richMenuReplies.byLabel(input);

    if (byLabel) {
      return {
        action: 'RICH_MENU_REPLY',
        intent: 'RICH_MENU_REPLY',
        confidence: 1,
        source: 'DATABASE',
        reason: `rich menu label "${byLabel.label}"`,
        richMenuReply: byLabel,
      };
    }

    return null;
  }

  private logDecision(
    input: string,
    decision: RouteDecision,
    retrieval?: KnowledgeRetrievalResult,
  ): RouteDecision {
    // Per-candidate scores are already on the [Retrieval] line; keep this one
    // to the decision itself so a flow reads as one line per stage.
    const evidence =
      retrieval?.selectedItems.map((item) => `${item.source}:${item.id}`) ?? [];
    const scores = (retrieval?.topScores ?? [])
      .slice(0, MAX_LOGGED_SCORES)
      .map((score) => score.toFixed(5));
    const hiddenScores = (retrieval?.topScores.length ?? 0) - scores.length;
    this.logger.debug(
      logBlock('Routing', [
        `query=${JSON.stringify(logSafeText(input))}`,
        `action=${decision.action}`,
        `intent=${decision.intent}`,
        `source=${decision.source}`,
        `confidence=${decision.confidence}`,
        // Rule/session gates answer before any search runs. Saying so beats
        // printing candidates=0, which reads as "searched and found nothing".
        retrieval ? null : 'retrieval=skipped (decided before search)',
        retrieval ? `retrievalRoute=${retrieval.route}` : null,
        retrieval ? `match=${retrieval.matchType}` : null,
        retrieval ? `candidates=${retrieval.items.length}` : null,
        retrieval ? `contextCandidates=${evidence.length}` : null,
        retrieval?.product
          ? `productMode=${retrieval.product.plan.mode}`
          : null,
        retrieval?.product
          ? `productStatus=${retrieval.product.result.status}`
          : null,
        retrieval?.product
          ? `productFailed=${retrieval.product.failed ?? false}`
          : null,
        retrieval?.product
          ? `productChoices=${retrieval.product.result.choices.length}`
          : null,
        scores.length
          ? `topScores=[${scores.join(', ')}${hiddenScores > 0 ? `, +${hiddenScores}` : ''}]`
          : null,
        scores.length
          ? `scoreGap=${retrieval?.scoreGap?.toFixed(5) ?? '-'}`
          : null,
        evidence.length
          ? `candidateRefs=${evidence.join('\n            ')}`
          : null,
        `reasonCode=${decision.fallbackReason ?? retrieval?.fallbackReason ?? '-'}`,
        `reason=${JSON.stringify(decision.reason ?? '')}`,
      ]),
    );
    return decision;
  }
}
