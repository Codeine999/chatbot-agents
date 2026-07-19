import { ChatAction, ChatIntent } from '../types/chat.types';

export type IntentRouteMapping = {
  action: ChatAction;
  reason: string;
};

/** Rule-path intent -> action mapping (rule confidence already >= 0.9 here). */
export const RULE_MAP: Record<ChatIntent, IntentRouteMapping> = {
  REGISTER: {
    action: 'START_REGISTER',
    reason: 'rule matched register keyword/menu',
  },
  REGISTER_HOW_TO: {
    action: 'ANSWER_KNOWLEDGE',
    reason: 'rule matched how-to-register, answer from knowledge base',
  },
  CONTACT_ADMIN: {
    action: 'CONTACT_ADMIN',
    reason: 'rule matched contact-admin',
  },
  CANCEL: {
    action: 'CANCEL_SESSION',
    reason: 'rule matched cancel keyword',
  },
  GENERAL_QUESTION: {
    action: 'GENERAL_QUESTION',
    reason: 'rule matched general question',
  },
  ANSWER_KNOWLEDGE: {
    action: 'ANSWER_KNOWLEDGE',
    reason: 'AI how-to-register, answer from knowledge base',
  },
  UNKNOWN: {
    action: 'GENERAL_QUESTION',
    reason: 'rule fallback',
  },
};

/** Non-business AI intents that never need backend verification. */
export const AI_MAP: Record<ChatIntent, IntentRouteMapping> = {
  CANCEL: {
    action: 'CANCEL_SESSION',
    reason: 'AI detected cancel',
  },
  REGISTER: {
    action: 'START_REGISTER',
    reason: 'AI detected registration intent',
  },
  REGISTER_HOW_TO: {
    action: 'ANSWER_KNOWLEDGE',
    reason: 'AI how-to-register, answer from knowledge base',
  },
  GENERAL_QUESTION: {
    action: 'GENERAL_QUESTION',
    reason: 'AI general question',
  },
  ANSWER_KNOWLEDGE: {
    action: 'ANSWER_KNOWLEDGE',
    reason: 'AI detected knowledge-base question',
  },
  CONTACT_ADMIN: {
    action: 'CONTACT_ADMIN',
    reason: 'AI detected admin handoff',
  },
  UNKNOWN: {
    action: 'GENERAL_QUESTION',
    reason: 'AI unknown, safe general answer',
  },
};
