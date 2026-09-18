import { IntentResult, RouteDecision } from '../types/chat.types';
import { RULE_MAP } from './intent.maps';

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
