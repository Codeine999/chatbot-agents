import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from './user-session.service';
import { RuleIntentService } from './rule-intent.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';
import {
  ChatContextMessage,
  IntentSource,
  KnowledgeRetrievalResult,
  RouteDecision,
} from './types/chat.types';
import { fromRule } from './intent/intent.utils';
import type { LineAiUsageContext } from '../usage/billing/ai-usage.types';

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);
  constructor(
    private readonly ruleIntentService: RuleIntentService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
    private readonly aiIntentClassifierService: AiIntentClassifierService,
  ) {}

  async resolve(
    params: LineAiUsageContext & {
      userId: string;
      input: string;
      session: ConversationSession | undefined;
      recentMessages?: readonly ChatContextMessage[];
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
    } = params;

    this.logger.debug(
      `session flow=
      ${session?.flow ?? 'none'} 
      step=${session?.step ?? 'none'} 
      status=${session?.status ?? 'none'}`,
    );

    //detect from rule base first
    const rule = this.ruleIntentService.detect(input);
    this.logger.debug(`rule = ${JSON.stringify(rule, null, 2)}`);

    if (rule.intent === 'CANCEL') {
      return this.logDecision({
        action: 'CANCEL_SESSION',
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason: 'cancel keyword clears session (top priority)',
      });
    }

    if (session?.status === 'ACTIVE' && session.flow === 'REGISTER') {
      if (
        rule.confidence >= 0.9 &&
        rule.intent !== 'UNKNOWN' &&
        rule.intent !== 'REGISTER'
      ) {
        return this.logDecision({
          ...fromRule(rule),
          source: 'SESSION',
          reason: `active REGISTER session interrupted by ${rule.intent}`,
        });
      }

      return this.logDecision({
        action: 'CONTINUE_REGISTER',
        intent: 'REGISTER',
        confidence: 1,
        source: 'SESSION',
        reason: 'active REGISTER session continues current flow',
      });
    }

    let ruleKnowledgeDecision: RouteDecision | undefined;

    if (rule.confidence >= 0.9) {
      const decision = fromRule(rule);

      this.logger.debug(`[fromRule] rule = ${JSON.stringify(rule, null, 2)}`);
      this.logger.debug(
        `[fromRule] decision = ${JSON.stringify(decision, null, 2)}`,
      );

      if (decision.action !== 'ANSWER_KNOWLEDGE') {
        return this.logDecision(decision);
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

    if (retrieval.route !== 'LOW_CONFIDENCE') {
      const decision: RouteDecision = {
        action: 'ANSWER_KNOWLEDGE',
        intent: ruleKnowledgeDecision?.intent ?? 'ANSWER_KNOWLEDGE',
        confidence: retrieval.topScores[0] ?? 0,
        source:
          ruleKnowledgeDecision?.source ?? this.retrievalSource(retrieval),
        reason: `knowledge retrieval selected ${retrieval.route}`,
        resolvedQuery: input,
        retrieval,
      };
      return this.logDecision(decision, retrieval);
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
        {
          action: 'GENERAL_QUESTION',
          intent: 'GENERAL_QUESTION',
          confidence: analysis.confidence,
          source: 'AI',
          reason: 'low-confidence retrieval classified as GENERAL',
          generatedResponse: analysis.response,
          fallbackReason,
        },
        retrieval,
        'LOW_CONFIDENCE',
      );
    }

    return this.logDecision(
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

  private logDecision(
    decision: RouteDecision,
    retrieval?: KnowledgeRetrievalResult,
    routeOverride?: string,
  ): RouteDecision {
    this.logger.debug(
      `[Routing] ${JSON.stringify({
        route: routeOverride ?? retrieval?.route ?? decision.action,
        matchType: retrieval?.matchType ?? 'NONE',
        topScores: retrieval?.topScores ?? [],
        scoreGap: retrieval?.scoreGap ?? null,
        attemptCount: retrieval?.attemptCount ?? 0,
        diagnosis: retrieval?.diagnosis ?? 'NONE',
        rewriteStrategy: retrieval?.rewriteStrategy ?? 'NONE',
        plannerUsedLlm: retrieval?.plannerUsedLlm ?? false,
        selectedKnowledgeIds:
          retrieval?.selectedItems.map((item) => item.id) ?? [],
        intent: decision.intent,
        confidence: decision.confidence,
        fallbackReason:
          decision.fallbackReason ?? retrieval?.fallbackReason ?? null,
      })}`,
    );
    return decision;
  }
}
