import type {
  IntentResult,
  IntentSource,
  KnowledgeRetrievalResult,
  RouteDecision,
} from '../../shared/types/chat.types';
import { fromRule } from './intent.utils';

/** A keyword rule at or above this confidence routes without AI. */
export const RULE_TRUST_CONFIDENCE = 0.9;

export type GateInput = Readonly<{
  input: string;
  rule: IntentResult;
  inRegister: boolean;
}>;

/**
 * Who recognised a knowledge question before search. Search still has to
 * ground the answer; the label only survives when retrieval is confident.
 */
export type KnowledgeLabel = Pick<
  RouteDecision,
  'intent' | 'confidence' | 'source'
>;

/** DECIDE answers without search; SEARCH ends gating and retrieves. */
export type GateVerdict =
  | { kind: 'DECIDE'; decision: RouteDecision }
  | { kind: 'SEARCH'; label?: KnowledgeLabel };

/** Returns null when the gate has no opinion and the next one decides. */
type Gate = (ctx: GateInput) => GateVerdict | null;

const decide = (decision: RouteDecision): GateVerdict => ({
  kind: 'DECIDE',
  decision,
});

const isTrusted = (rule: IntentResult) =>
  rule.confidence >= RULE_TRUST_CONFIDENCE;

/** Rule actions are final, except knowledge, which still needs evidence. */
function fromTrustedRule(decision: RouteDecision): GateVerdict {
  if (decision.action !== 'ANSWER_KNOWLEDGE') return decide(decision);

  const { intent, confidence, source } = decision;
  return { kind: 'SEARCH', label: { intent, confidence, source } };
}

const greeting: Gate = ({ rule }) =>
  rule.intent === 'GREET' && isTrusted(rule) ? decide(fromRule(rule)) : null;

const cancel: Gate = ({ rule }) =>
  rule.intent === 'CANCEL'
    ? decide({
        action: 'CANCEL_SESSION',
        intent: 'CANCEL',
        confidence: 1,
        source: 'RULE',
        reason: 'cancel keyword exits',
      })
    : null;

/** Inside registration a message is form input unless a trusted rule interrupts. */
const registerSession: Gate = ({ rule, inRegister }) => {
  if (!inRegister) return null;

  if (
    isTrusted(rule) &&
    rule.intent !== 'UNKNOWN' &&
    rule.intent !== 'REGISTER'
  ) {
    return fromTrustedRule({
      ...fromRule(rule),
      source: 'SESSION',
      reason: `active REGISTER session interrupted by ${rule.intent}`,
    });
  }

  return decide({
    action: 'CONTINUE_REGISTER',
    intent: 'REGISTER',
    confidence: 1,
    source: 'SESSION',
    reason: 'active REGISTER session continues current flow',
  });
};

const trustedRule: Gate = ({ rule }) =>
  isTrusted(rule) ? fromTrustedRule(fromRule(rule)) : null;

/**
 * Order is policy; the first gate with an opinion wins.
 * - greeting before registerSession: "สอบถามหน่อย" mid-flow is not form input.
 * - cancel before registerSession: cancel always exits a flow.
 * - registerSession before trustedRule: inside a flow only interruptions escape.
 */
const GATES: readonly Gate[] = [greeting, cancel, registerSession, trustedRule];

/** Deterministic routing before any search; no I/O. */
export function gateBeforeSearch(ctx: GateInput): GateVerdict {
  for (const gate of GATES) {
    const verdict = gate(ctx);
    if (verdict) return verdict;
  }

  return { kind: 'SEARCH' };
}

/**
 * Maps a retrieval result to a decision. Null means low confidence: only the
 * BUSINESS/GENERAL classifier may decide, and the knowledge label is dropped.
 */
export function decideFromRetrieval(
  retrieval: KnowledgeRetrievalResult,
  input: string,
  label?: KnowledgeLabel,
): RouteDecision | null {
  const { fallbackReason } = retrieval;

  if (retrieval.product) {
    return {
      action: 'ANSWER_KNOWLEDGE',
      intent: 'ANSWER_KNOWLEDGE',
      confidence: 0,
      source: 'DATABASE',
      retrieval,
      resolvedQuery: input,
      reason: `product plan ${retrieval.product.plan.mode}`,
    };
  }

  if (fallbackReason === 'MISSING_USER_INFORMATION') {
    return {
      action: 'CLARIFY',
      intent: 'ANSWER_KNOWLEDGE',
      confidence: 0,
      source: 'DATABASE',
      fallbackReason,
    };
  }

  if (
    fallbackReason === 'CONFLICTING_CANDIDATES' ||
    fallbackReason === 'RETRIEVAL_ERROR'
  ) {
    return {
      action: 'CONTACT_ADMIN',
      intent: 'CONTACT_ADMIN',
      confidence: 1,
      source: 'DATABASE',
      businessFallback: true,
      fallbackReason,
    };
  }

  if (retrieval.route !== 'LOW_CONFIDENCE') {
    return {
      action: 'ANSWER_KNOWLEDGE',
      intent: label?.intent ?? 'ANSWER_KNOWLEDGE',
      confidence: label?.confidence ?? 0,
      source: label?.source ?? retrievalSource(retrieval),
      reason: `knowledge retrieval selected ${retrieval.route}`,
      resolvedQuery: input,
      retrieval,
    };
  }

  if (retrieval.plannerIntent === 'KNOWLEDGE') {
    return retrieval.selectedItems.length
      ? {
          action: 'ANSWER_KNOWLEDGE',
          intent: 'ANSWER_KNOWLEDGE',
          confidence: 0,
          source: 'AI',
          reason: 'product planner classified KNOWLEDGE',
          resolvedQuery: input,
          retrieval,
        }
      : {
          action: 'CONTACT_ADMIN',
          intent: 'CONTACT_ADMIN',
          confidence: 0,
          source: 'AI',
          reason: 'product planner classified KNOWLEDGE without evidence',
          businessFallback: true,
          fallbackReason,
        };
  }

  return null;
}

function retrievalSource(retrieval: KnowledgeRetrievalResult): IntentSource {
  if (retrieval.matchType === 'EMBEDDING' || retrieval.matchType === 'HYBRID') {
    return 'EMBEDDING';
  }

  return retrieval.selectedItems[0]?.metadata?.retrievalLayer === 'DATABASE'
    ? 'DATABASE'
    : 'CACHE';
}
