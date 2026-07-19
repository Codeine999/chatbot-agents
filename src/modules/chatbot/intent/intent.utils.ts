import {
  AiIntentAnalysis,
  IntentResult,
  RouteDecision,
} from '../types/chat.types';
import { AI_CONFIDENCE_THRESHOLD } from './intent.constants';
import { AI_MAP, RULE_MAP } from './intent.maps';

export function fromRule(rule: IntentResult): RouteDecision {
  const mapped = RULE_MAP[rule.intent] ?? {
    action: 'GENERAL_QUESTION',
    reason: 'rule fallback',
  };
  return {
    action: mapped.action,
    intent: rule.intent,
    confidence: rule.confidence,
    source: 'RULE',
    reason: rule.reason ? `${rule.reason} -> ${mapped.action}` : mapped.reason,
  };
}

export function fromAi(ai: AiIntentAnalysis): RouteDecision {
  const resolvedQuery = ai.standaloneQuery?.trim() || undefined;

  if (ai.confidence < AI_CONFIDENCE_THRESHOLD) {
    return {
      action: 'FALLBACK',
      intent: 'UNKNOWN',
      confidence: ai.confidence,
      source: 'AI',
      reason:
        'AI confidence < 0.6, return exact fallback without Gemini answer',
      resolvedQuery,
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
    resolvedQuery,
  };
}