import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from './user-session.service';
import { RuleIntentService } from './rule-intent.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { KnowledgeCandidateService } from './knowledge/knowledge-candidate.service';
import { ChatContextMessage, RouteDecision } from './types/chat.types';
import { fromAi, fromRule } from './intent/intent.utils';

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);
  constructor(
    private readonly ruleIntentService: RuleIntentService,
    private readonly knowledgeCandidateService: KnowledgeCandidateService,
    private readonly aiIntentClassifierService: AiIntentClassifierService,
  ) {}

  async resolve(params: {
    userId: string;
    input: string;
    session: ConversationSession | undefined;
    recentMessages?: readonly ChatContextMessage[];
  }): Promise<RouteDecision> {
    const { userId, input, session, recentMessages = [] } = params;
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
      return {
        action: 'CANCEL_SESSION',
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason: 'cancel keyword clears session (top priority)',
      };
    }

    if (session?.status === 'ACTIVE' && session.flow === 'REGISTER') {
      if (
        rule.confidence >= 0.9 &&
        rule.intent !== 'UNKNOWN' &&
        rule.intent !== 'REGISTER'
      ) {
        return {
          ...fromRule(rule),
          source: 'SESSION',
          reason: `active REGISTER session interrupted by ${rule.intent}`,
        };
      }

      return {
        action: 'CONTINUE_REGISTER',
        intent: 'REGISTER',
        confidence: 1,
        source: 'SESSION',
        reason: 'active REGISTER session continues current flow',
      };
    }

    if (rule.confidence >= 0.9) {
      const decision = fromRule(rule);

      this.logger.debug(`[fromRule] rule = ${JSON.stringify(rule, null, 2)}`);
      this.logger.debug(
        `[fromRule] decision = ${JSON.stringify(decision, null, 2)}`,
      );

      return decision;
    }

    // Knowledge candidate check (in-memory AnswerPattern cache) runs before
    // the AI classifier so FAQ questions never get misrouted to GENERAL_QUESTION.
    // A raw-text match is only trusted when there is no recent conversation to
    // refer back to, or when the whole message equals a pattern exactly. Other
    // follow-ups (e.g. "ราคาเท่าไรละ" after asking about a product) must go to
    // the classifier, which resolves references into standaloneQuery first.
    const candidate = this.knowledgeCandidateService.detect(input);
    const hasRecentContext = recentMessages.length > 0;

    if (candidate.matched && (!hasRecentContext || candidate.exact)) {
      const decision: RouteDecision = {
        action: 'ANSWER_KNOWLEDGE',
        intent: 'ANSWER_KNOWLEDGE',
        confidence: candidate.confidence,
        source: 'CACHE',
        reason: candidate.reason,
      };
      this.logger.debug(
        `[KnowledgeCandidate] decision = ${JSON.stringify(decision, null, 2)}`,
      );
      return decision;
    }

    const ai = await this.aiIntentClassifierService.analyze(input, {
      userId,
      recentMessages,
    });
    this.logger.debug(
      `[AI] intent=${ai.intent} confidence=${ai.confidence} ` +
        `rewritten=${Boolean(ai.standaloneQuery)}`,
    );

    const decision = fromAi(ai);

    // Classifier over budget, failed, or unsure: a weak raw-text FAQ match
    // still beats returning the canned fallback message.
    if (decision.action === 'FALLBACK' && candidate.matched) {
      const degraded: RouteDecision = {
        action: 'ANSWER_KNOWLEDGE',
        intent: 'ANSWER_KNOWLEDGE',
        confidence: candidate.confidence,
        source: 'CACHE',
        reason: `classifier fallback, degraded to: ${candidate.reason}`,
      };
      this.logger.debug(
        `[KnowledgeCandidate] degraded decision = ${JSON.stringify(degraded, null, 2)}`,
      );
      return degraded;
    }

    this.logger.debug(`[AI] decision = ${JSON.stringify(decision, null, 2)}`);
    return decision;
  }
}
