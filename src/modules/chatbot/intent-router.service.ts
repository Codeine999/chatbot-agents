import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from './user-session.service';
import { RuleIntentService } from './rule-intent.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';

import { RichMenuReplyCacheService } from './menu/rich-menu-reply-cache.service';
import { parseMenuPostback } from '../../shared/richMenu/menu-postback';
import {
  ChatContextMessage,
  IntentSource,
  KnowledgeRetrievalResult,
  RouteDecision,
} from './types/chat.types';
import { fromRule } from './intent/intent.utils';
import { logBlock, logSafeText } from '../../utils/text.utils';
import type { LineAiUsageContext } from '../usage/billing/ai-usage.types';

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

    const menuDecision = this.resolveRichMenu(postbackData, input);
    console.log('menuDecision', menuDecision)
    if (menuDecision) return this.logDecision(input, menuDecision);

    //detect from rule base first
    const rule = this.ruleIntentService.detect(input);
    this.logger.debug(
      logBlock('Rule', [
        `intent=${rule.intent}`,
        `confidence=${rule.confidence}`,
        `source=${rule.source}`,
        `reason=${JSON.stringify(rule.reason ?? '')}`,
      ]),
    );

    if (rule.intent === 'CANCEL') {
      return this.logDecision(input, {
        action: 'CANCEL_SESSION',
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason:
          'cancel keyword exits registration only; never releases admin mute',
      });
    }

    let ruleKnowledgeDecision: RouteDecision | undefined;

    if (session?.status === 'ACTIVE' && session.flow === 'REGISTER') {
      if (
        rule.confidence >= 0.9 &&
        rule.intent !== 'UNKNOWN' &&
        rule.intent !== 'REGISTER'
      ) {
        const interruption: RouteDecision = {
          ...fromRule(rule),
          source: 'SESSION',
          reason: `active REGISTER session interrupted by ${rule.intent}`,
        };
        if (interruption.action !== 'ANSWER_KNOWLEDGE')
          return this.logDecision(input, interruption);
        ruleKnowledgeDecision = interruption;
      }

      if (!ruleKnowledgeDecision)
        return this.logDecision(input, {
          action: 'CONTINUE_REGISTER',
          intent: 'REGISTER',
          confidence: 1,
          source: 'SESSION',
          reason: 'active REGISTER session continues current flow',
        });
    }

    if (
      /^(?:สวัสดี|หวัดดี|ขอบคุณ|โอเค)(?:ครับ|ค่ะ|คะ|นะครับ|นะคะ)?[!. ]*$|^(?:hi|hello|thanks|thank you|ok|okay)[!. ]*$/iu.test(
        input,
      )
    ) {
      return this.logDecision(input, {
        action: 'CONTINUE_AI_CHAT',
        intent: 'GENERAL_QUESTION',
        confidence: 1,
        source: 'RULE',
        reason: 'whole-message greeting or acknowledgment',
      });
    }

    if (!ruleKnowledgeDecision && rule.confidence >= 0.9) {
      const decision = fromRule(rule);

      if (decision.action !== 'ANSWER_KNOWLEDGE') {
        return this.logDecision(input, decision);
      }

      ruleKnowledgeDecision = decision;
    }

    // Rule/session routing ends here; retrieval owns cache -> DB -> embedding.
    const retrieval = await this.knowledgeRetrievalService.retrieve(input, {
      userId,
      lineMemberId,
      conversationId,
      turnId,
      recentMessages,
    });

    if (retrieval.fallbackReason === 'MISSING_USER_INFORMATION') {
      return this.logDecision(input, {
        action: 'CLARIFY',
        intent: 'ANSWER_KNOWLEDGE',
        confidence: 0,
        source: 'DATABASE',
        fallbackReason: retrieval.fallbackReason,
      });
    }
    if (
      retrieval.fallbackReason === 'CONFLICTING_CANDIDATES' ||
      retrieval.fallbackReason === 'RETRIEVAL_ERROR'
    ) {
      return {
        action: 'CONTACT_ADMIN',
        intent: 'CONTACT_ADMIN',
        confidence: 1,
        source: 'DATABASE',
        businessFallback: true,
        fallbackReason: retrieval.fallbackReason,
      };
    }
    if (retrieval.route !== 'LOW_CONFIDENCE') {
      const decision: RouteDecision = {
        action: 'ANSWER_KNOWLEDGE',
        intent: ruleKnowledgeDecision?.intent ?? 'ANSWER_KNOWLEDGE',
        // Retrieval rank is diagnostic, not intent confidence.
        confidence: ruleKnowledgeDecision?.confidence ?? 0,
        source:
          ruleKnowledgeDecision?.source ?? this.retrievalSource(retrieval),
        reason: `knowledge retrieval selected ${retrieval.route}`,
        resolvedQuery: input,
        retrieval,
      };
      return this.logDecision(input, decision, retrieval);
    }

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
      fallbackReason?: string;
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
        'LOW_CONFIDENCE',
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
      'LOW_CONFIDENCE',
    );
  }

  private retrievalSource(retrieval: KnowledgeRetrievalResult): IntentSource {
    if (
      retrieval.matchType === 'EMBEDDING' ||
      retrieval.matchType === 'HYBRID'
    ) {
      return 'EMBEDDING';
    }

    return retrieval.selectedItems[0]?.metadata?.retrievalLayer === 'DATABASE'
      ? 'DATABASE'
      : 'CACHE';
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
    routeOverride?: string,
  ): RouteDecision {
    // Per-candidate scores are already on the [Retrieval] line; keep this one
    // to the decision itself so a flow reads as one line per stage.
    const evidence =
      retrieval?.selectedItems.map((item) => `${item.source}:${item.id}`) ?? [];
    const scores = (retrieval?.topScores ?? [])
      .slice(0, MAX_LOGGED_SCORES)
      .map((score) => score.toFixed(5));
    const hiddenScores = (retrieval?.topScores.length ?? 0) - scores.length;
    const route = routeOverride ?? retrieval?.route;
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
        route ? `route=${route}` : null,
        retrieval ? `match=${retrieval.matchType}` : null,
        retrieval ? `candidates=${retrieval.items.length}` : null,
        retrieval ? `selected=${evidence.length}` : null,
        scores.length
          ? `topScores=[${scores.join(', ')}${hiddenScores > 0 ? `, +${hiddenScores}` : ''}]`
          : null,
        scores.length
          ? `scoreGap=${retrieval?.scoreGap?.toFixed(5) ?? '-'}`
          : null,
        evidence.length ? `evidence=${evidence.join('\n            ')}` : null,
        `fallback=${decision.fallbackReason ?? retrieval?.fallbackReason ?? '-'}`,
        `reason=${JSON.stringify(decision.reason ?? '')}`,
      ]),
    );
    return decision;
  }
}
