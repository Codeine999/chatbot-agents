import { normalizeText, redactPii } from '../../../utils/text.utils';
import type { ChatContextMessage } from '../types/chat.types';
import { CLARIFY_MESSAGE } from '../constants/knowledge-routing.constants';

const MAX_HISTORY_MESSAGES = 6;
const MAX_CONTEXT_CHARACTERS = 160;
const FOLLOW_UP =
  /อันนี้|อันนั้น|ตัวนี้|ตัวนั้น|เมื่อกี้|อันเดิม|เหมือนเดิม|เหมือนก่อน|โรงแรมนี้|โปรโมชันนี้|โปรโมชั่นนี้|โปรนี้|สินค้านี้|บริการนี้|\b(?:it|this one|that one|same one)\b/iu;
const AMBIGUOUS_CONTEXT = /(?:กับ|หรือ|ระหว่าง|เทียบ|เปรียบเทียบ)/u;
const PRIVATE_CONTEXT =
  /@|\[REDACTED_|(?:ชื่อ|นามสกุล|ที่อยู่|เลขบัญชี|บัญชีธนาคาร|รหัสผ่าน|password|passcode)/iu;
const SOCIAL_MESSAGE =
  /^(?:(?:สวัสดี|หวัดดี|ขอบคุณ|โอเค)(?:ครับ|ค่ะ|คะ)?|ครับ|ค่ะ|คะ|hi|hello|thanks|ok|okay)[!. ]*$/iu;

/** Rewrite a clear follow-up using bounded, already-delivered user history.
 * Ambiguous or private context asks for details rather than searching for a
 * guessed subject. This planner makes no provider call.
 */
export function resolveRetrievalQuery(
  input: string,
  history: readonly ChatContextMessage[],
): { query: string; missingReference: boolean } {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  const lastUser = [...recent]
    .reverse()
    .find((message) => message.role === 'user');
  const lastAssistant = recent.at(-1);

  // CLARIFY turns are kept in the existing three-turn context. A short reply
  // supplies the missing subject for the preceding question without new state.
  if (
    lastAssistant?.role === 'assistant' &&
    lastAssistant.text === CLARIFY_MESSAGE &&
    lastUser &&
    FOLLOW_UP.test(lastUser.text) &&
    !FOLLOW_UP.test(input) &&
    !SOCIAL_MESSAGE.test(input) &&
    safeContext(input) &&
    safeContext(lastUser.text)
  ) {
    return { query: `${input}\n${lastUser.text}`, missingReference: false };
  }

  if (!FOLLOW_UP.test(input)) return { query: input, missingReference: false };

  const mentions = (text: string) =>
    [...text.matchAll(/(?:รุ่น|model)\s+([\p{L}\p{M}\p{N}_-]+)/giu)].map(
      (match) => normalizeText(match[1]),
    );
  const explicit = new Set(mentions(input));
  if (explicit.size === 1) return { query: input, missingReference: false };
  if (explicit.size > 1) return { query: input, missingReference: true };

  const entities = new Set(
    recent.flatMap((message) => mentions(message.text.slice(0, 1000))),
  );
  if (entities.size > 1) return { query: input, missingReference: true };
  if (entities.size === 1) {
    const [entity] = entities;
    return { query: `รุ่น ${entity}\n${input}`, missingReference: false };
  }

  if (
    !lastUser ||
    !safeContext(lastUser.text) ||
    FOLLOW_UP.test(lastUser.text)
  ) {
    return { query: input, missingReference: true };
  }
  return { query: `${lastUser.text}\n${input}`, missingReference: false };
}

function safeContext(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    Array.from(trimmed).length <= MAX_CONTEXT_CHARACTERS &&
    !SOCIAL_MESSAGE.test(trimmed) &&
    !AMBIGUOUS_CONTEXT.test(trimmed) &&
    !PRIVATE_CONTEXT.test(trimmed) &&
    redactPii(trimmed) === trimmed
  );
}
