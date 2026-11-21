import { normalizeText, redactPii } from '../../utils/text.utils';
import type { ChatContextMessage } from '../../shared/contracts/chat.types';
import { CLARIFY_MESSAGE } from '../../shared/knowledge/knowledge-routing.constants';
import {
  AMBIGUOUS_CONTEXT,
  FOLLOW_UP,
  PRIVATE_CONTEXT,
  SOCIAL_MESSAGE,
} from './utils/follow-up-patterns';
import { catalogLexicon } from '../products/search/catalog-fields';

const MAX_HISTORY_MESSAGES = 6;
const MAX_CONTEXT_CHARACTERS = 160;

// for combine data to complete question by load history and make
// question with history to complete question
export function resolveRetrievalQuery(
  input: string,
  history: readonly ChatContextMessage[],
  entityMarkers: readonly string[] = catalogLexicon(null).entityMarkers,
): { query: string; missingReference: boolean } {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  const lastUser = [...recent]
    .reverse()
    .find((message) => message.role === 'user');
  const lastAssistant = recent.at(-1);

  // A number after an assistant question is an answer in the current topic.
  if (/^\d+(?:[.,]\d+)?$/u.test(input)) {
    if (
      lastAssistant?.role === 'assistant' &&
      lastUser &&
      safeContext(lastUser.text)
    ) {
      return { query: `${lastUser.text}\n${input}`, missingReference: false };
    }
    return { query: input, missingReference: true };
  }

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

  // "<marker> <name>" pairs for this business, e.g. "รุ่น A" or "เส้นทาง กรุงเทพ".
  const markerPattern =
    entityMarkers.length > 0
      ? new RegExp(
          `(${entityMarkers.map(escapeRegExp).join('|')})\\s+([\\p{L}\\p{M}\\p{N}_-]+)`,
          'giu',
        )
      : undefined;
  const mentions = (text: string): { marker: string; name: string }[] =>
    markerPattern
      ? [...text.matchAll(markerPattern)].map((match) => ({
          marker: normalizeText(match[1]),
          name: normalizeText(match[2]),
        }))
      : [];

  const explicit = new Set(mentions(input).map((item) => item.name));
  if (explicit.size === 1) return { query: input, missingReference: false };
  if (explicit.size > 1) return { query: input, missingReference: true };

  // name -> the marker it was written with, so the rebuilt query keeps the
  // business's own wording ("รุ่น a", "เส้นทาง กรุงเทพ").
  const entities = new Map(
    recent.flatMap((message) =>
      mentions(message.text.slice(0, 1000)).map(
        (item) => [item.name, item.marker] as const,
      ),
    ),
  );
  if (entities.size > 1) return { query: input, missingReference: true };
  if (entities.size === 1) {
    const [[name, marker]] = entities;
    return {
      query: `${marker} ${name}\n${input}`,
      missingReference: false,
    };
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
