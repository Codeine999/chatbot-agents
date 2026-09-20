import { CHAT_INTENTS, type ChatIntent } from '../../modules/chatbot/types/chat.types';

/**
 * What a rich menu button sends back when a customer taps it.
 *
 * A menu on LINE is immutable and lives on the customer's phone long after it
 * is replaced here, so the button has to describe itself. Two grammars exist:
 *
 * - `intent=REGISTER` — a capability the product implements in code.
 * - `menu=promo_today` — an answer the tenant wrote, resolved from
 *   `RichMenuReply` at chat time so editing the wording never republishes.
 *
 * Anything else is left alone: it may be a tenant's own convention from before
 * this format, and the router simply falls through to normal routing.
 */
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
