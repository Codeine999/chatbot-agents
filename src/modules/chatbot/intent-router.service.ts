import { Injectable } from '@nestjs/common';
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
  REGISTER: { action: 'START_REGISTER', reason: 'rule matched register keyword/menu' },
  AI_CHAT: { action: 'START_AI_CHAT', reason: 'rule matched AI-chat menu' },
  REGISTER_HOW_TO: { action: 'ANSWER_KNOWLEDGE', reason: 'rule matched how-to-register, answer from knowledge base' },
  CONTACT_ADMIN: { action: 'CONTACT_ADMIN', reason: 'rule matched contact-admin' },
  CHECK_STATUS: { action: 'CHECK_STATUS', reason: 'rule matched status check' },
  CHECK_PAYMENT_STATUS: { action: 'CHECK_STATUS', reason: 'rule matched payment-status keyword' },
  CANCEL: { action: 'CANCEL_SESSION', reason: 'rule matched cancel keyword' },
  GENERAL_QUESTION: { action: 'ANSWER_GENERAL', reason: 'rule matched general question' },
  UNKNOWN: { action: 'ANSWER_GENERAL', reason: 'rule fallback' },
};

function fromRule(rule: IntentResult): RouteDecision {
  const mapped = RULE_MAP[rule.intent] ?? { action: 'ANSWER_GENERAL', reason: 'rule fallback' };
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
  REGISTER: { action: 'START_REGISTER', reason: 'AI detected registration intent' },
  // AI_CHAT from the classifier must NOT start a session — just answer generally.
  AI_CHAT: { action: 'ANSWER_GENERAL', reason: 'AI casual chat, answer generally (no session)' },
  REGISTER_HOW_TO: { action: 'ANSWER_KNOWLEDGE', reason: 'AI how-to-register, answer from knowledge base' },
  CONTACT_ADMIN: { action: 'CONTACT_ADMIN', reason: 'AI detected admin handoff' },
  CHECK_STATUS: { action: 'CHECK_STATUS', reason: 'AI status check, verify via backend/admin' },
  CHECK_PAYMENT_STATUS: { action: 'CHECK_STATUS', reason: 'AI payment-status check, verify via backend/admin' },
  CANCEL: { action: 'CANCEL_SESSION', reason: 'AI detected cancel' },
  // GENERAL_QUESTION is handled explicitly below (knowledge vs. general).
  GENERAL_QUESTION: { action: 'ANSWER_GENERAL', reason: 'AI general question' },
  UNKNOWN: { action: 'ANSWER_GENERAL', reason: 'AI unknown, safe general answer' },
};

function fromAi(ai: AiIntentAnalysis): RouteDecision {
  // Gate 1: low confidence -> safe general answer, drop the guessed intent.
  if (ai.confidence < 0.6) {
    return {
      action: 'ANSWER_GENERAL',
      intent: 'UNKNOWN',
      confidence: ai.confidence,
      source: 'AI',
      reason: 'AI confidence < 0.6, fall back to safe general answer',
    };
  }

  // Gate 2: needs backend data -> must be verified. Never answer with AI.
  if (ai.needsBusinessData) {
    return {
      action: 'CHECK_STATUS',
      intent: ai.intent,
      confidence: ai.confidence,
      source: 'AI',
      reason: 'AI flagged needsBusinessData, verify via backend/admin (no AI answer)',
    };
  }

  // Gate 3: general question -> knowledge lookup vs. plain general chat.
  if (ai.intent === 'GENERAL_QUESTION') {
    return ai.needsKnowledgeSearch
      ? {
          action: 'ANSWER_KNOWLEDGE',
          intent: 'GENERAL_QUESTION',
          confidence: ai.confidence,
          source: 'AI',
          reason: 'general question needs knowledge-base lookup',
        }
      : {
          action: 'ANSWER_GENERAL',
          intent: 'GENERAL_QUESTION',
          confidence: ai.confidence,
          source: 'AI',
          reason: 'general question, no knowledge lookup needed',
        };
  }

  const mapped = AI_MAP[ai.intent] ?? { action: 'ANSWER_GENERAL', reason: 'AI unmapped intent, safe general answer' };
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

    const rule = this.ruleIntentService.detect(input);

    // Priority 1: CANCEL always clears the session, even mid-flow.
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
      if (session.flow === 'AI_CHAT') {
        return {
          action: 'CONTINUE_AI_CHAT',
          intent: 'AI_CHAT',
          confidence: 1,
          source: 'SESSION',
          reason: 'active AI_CHAT session continues current flow',
        };
      }
    }

    // Priority 3: new intent — trust a confident rule, otherwise ask the AI classifier.
    if (rule.confidence >= 0.9) {
      return fromRule(rule);
    }

    const ai = await this.aiIntentClassifierService.analyze(input);
    return fromAi(ai);
  }
}
