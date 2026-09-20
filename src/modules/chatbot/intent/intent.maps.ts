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
    action: 'START_AI_CHAT',
    reason: 'rule matched general question menu',
  },
  ANSWER_KNOWLEDGE: {
    action: 'ANSWER_KNOWLEDGE',
    reason: 'AI how-to-register, answer from knowledge base',
  },
  RICH_MENU_REPLY: {
    action: 'RICH_MENU_REPLY',
    reason: 'rich menu button answered from the tenant reply table',
  },
  UNKNOWN: {
    action: 'GENERAL_QUESTION',
    reason: 'rule fallback',
  },
};
