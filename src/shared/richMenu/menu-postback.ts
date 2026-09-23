import { CHAT_INTENTS, type ChatIntent } from '../../modules/chatbot/types/chat.types';

export type MenuPostback =
  | { kind: 'intent'; intent: ChatIntent }
  | { kind: 'reply'; key: string };

/** Lowercase slug, so a key stays readable in logs and stable in a URL. */
export const MENU_REPLY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const MENU_POSTBACK_INTENT_PREFIX = 'intent=';
export const MENU_POSTBACK_REPLY_PREFIX = 'menu=';

export const encodeMenuReplyPostback = (key: string): string =>
  `${MENU_POSTBACK_REPLY_PREFIX}${key}`;

export const encodeMenuIntentPostback = (intent: ChatIntent): string =>
  `${MENU_POSTBACK_INTENT_PREFIX}${intent}`;

export function parseMenuPostback(data: string): MenuPostback | null {
  const value = data.trim();

  if (value.startsWith(MENU_POSTBACK_INTENT_PREFIX)) {
    const intent = value.slice(MENU_POSTBACK_INTENT_PREFIX.length);
    return CHAT_INTENTS.includes(intent as ChatIntent)
      ? { kind: 'intent', intent: intent as ChatIntent }
      : null;
  }

  if (value.startsWith(MENU_POSTBACK_REPLY_PREFIX)) {
    const key = value.slice(MENU_POSTBACK_REPLY_PREFIX.length);
    return MENU_REPLY_KEY_PATTERN.test(key) ? { kind: 'reply', key } : null;
  }

  return null;
}

/** True when the string uses one of the two grammars, whatever it resolves to. */
export function isMenuPostback(data: string): boolean {
  const value = data.trim();
  return (
    value.startsWith(MENU_POSTBACK_INTENT_PREFIX) ||
    value.startsWith(MENU_POSTBACK_REPLY_PREFIX)
  );
}
