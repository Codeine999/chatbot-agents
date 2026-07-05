import { Injectable, Logger } from '@nestjs/common';
import { ConversationSession } from './user-session.service';
import { RuleIntentService } from './rule-intent.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import {
  AiIntentAnalysis,
  ChatAction,
  ChatIntent,
  IntentResult,
  RouteDecision,
} from './types/chat.types';

/** Rule-path intent -> action mapping (rule confidence already >= 0.9 here). */
const RULE_MAP: Record<ChatIntent, { action: ChatAction; reason: string }> = {
  REGISTER: { 
    action: 'START_REGISTER', 
    reason: 'rule matched register keyword/menu' 
  },
  REGISTER_HOW_TO: { 
    action: 'ANSWER_KNOWLEDGE', 
    reason: 'rule matched how-to-register, answer from knowledge base' 
  },
  CONTACT_ADMIN: { 
    action: 'CONTACT_ADMIN', 
    reason: 'rule matched contact-admin' 
  },
  CANCEL: { 
    action: 'CANCEL_SESSION', 
    reason: 'rule matched cancel keyword' 
  },
  GENERAL_QUESTION: { 
    action: 'GENERAL_QUESTION', 
    reason: 'rule matched general question' 
  },
  ANSWER_KNOWLEDGE: { 
    action: 'ANSWER_KNOWLEDGE', 
    reason: 'AI how-to-register, answer from knowledge base' 
  },
  UNKNOWN: { 
    action: 'GENERAL_QUESTION', 
    reason: 'rule fallback' 
  },
};

function fromRule(rule: IntentResult): RouteDecision {
  const mapped = RULE_MAP[rule.intent] ?? { action: 'GENERAL_QUESTION', reason: 'rule fallback' };
  return {
    action: mapped.action,
    intent: rule.intent,
    confidence: rule.confidence,
    source: 'RULE',
    reason: rule.reason ? `${rule.reason} -> ${mapped.action}` : mapped.reason,
  };
}

/** Non-business AI intents that never need backend verification. */
const AI_MAP: Record<ChatIntent, { action: ChatAction; reason: string }> = {
  CANCEL: { 
    action: 'CANCEL_SESSION', 
    reason: 'AI detected cancel' 
  },
  REGISTER: { 
    action: 'START_REGISTER', 
    reason: 'AI detected registration intent' 
  },
  REGISTER_HOW_TO: { 
    action: 'ANSWER_KNOWLEDGE', 
    reason: 'AI how-to-register, answer from knowledge base' 
  },
  GENERAL_QUESTION: { 
    action: 'GENERAL_QUESTION', 
    reason: 'AI general question' 
  },
  ANSWER_KNOWLEDGE: { 
    action: 'ANSWER_KNOWLEDGE', 
    reason: 'AI detected knowledge-base question' 
  },
  CONTACT_ADMIN: { 
    action: 'CONTACT_ADMIN', 
    reason: 'AI detected admin handoff' 
  },
  UNKNOWN: { 
    action: 'GENERAL_QUESTION', 
    reason: 'AI unknown, safe general answer'
  },
};

function fromAi(ai: AiIntentAnalysis): RouteDecision {
  if (ai.confidence < 0.6) {
    return {
      action: 'GENERAL_QUESTION',
      intent: 'UNKNOWN',
      confidence: ai.confidence,
      source: 'AI',
      reason: 'AI confidence < 0.6, fallback to general question',
    };
  }

  const mapped = AI_MAP[ai.intent] ?? {
    action: 'GENERAL_QUESTION',
    reason: 'AI unmapped intent, fallback to general question',
  };

  return {
    action: mapped.action,
    intent: ai.intent,
    confidence: ai.confidence,
    source: 'AI',
    reason: mapped.reason,
  };
}

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);
  constructor(
    private readonly ruleIntentService: RuleIntentService,
    private readonly aiIntentClassifierService: AiIntentClassifierService,
  ) {}

  async resolve(params: {
    userId: string;
    input: string;
    session: ConversationSession | undefined;
  }): Promise<RouteDecision> {
    const { input, session } = params;
    this.logger.debug(`session = ${JSON.stringify(session, null, 2)}`);

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

    // Priority 2: an ACTIVE session continues its current flow.
    if (session?.status === 'ACTIVE') {
      if (session.flow === 'REGISTER') {
        return {
          action: 'CONTINUE_REGISTER',
          intent: 'REGISTER',
          confidence: 1,
          source: 'SESSION',
          reason: 'active REGISTER session continues current flow',
        };
      }
    }

    if (rule.confidence >= 0.9) {
      const decision = fromRule(rule);

      this.logger.debug(`[fromRule] rule = ${JSON.stringify(rule, null, 2)}`);
      this.logger.debug(`[fromRule] decision = ${JSON.stringify(decision, null, 2)}`);

      return decision;
    }

    const ai = await this.aiIntentClassifierService.analyze(input);
    this.logger.debug(`[AI] result = ${JSON.stringify(ai, null, 2)}`);

    const decision = fromAi(ai);

    this.logger.debug(`[AI] decision = ${JSON.stringify(decision, null, 2)}`);
    return decision;
  }
}
