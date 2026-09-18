import { normalizeText } from '../../../utils/text.utils';
import type { ChatContextMessage } from '../types/chat.types';

/** No provider, no search loop. Unknown references ask for details instead of
 * choosing an entity by vector score. Only explicit model mentions are resolved.
 */
export function resolveRetrievalQuery(
  input: string,
  history: readonly ChatContextMessage[],
): { query: string; missingReference: boolean } {
  const followUp =
    /อันนี้|อันนั้น|ตัวนี้|ตัวนั้น|เมื่อกี้|อันเดิม|เหมือนเดิม|เหมือนก่อน|\b(?:it|this one|that one|same one)\b/iu.test(
      input,
    );
  if (!followUp) return { query: input, missingReference: false };

  const mentions = (text: string) =>
    [...text.matchAll(/(?:รุ่น|model)\s+([\p{L}\p{M}\p{N}_-]+)/giu)].map(
      (match) => normalizeText(match[1]),
    );
  const explicit = new Set(mentions(input));
  if (explicit.size === 1) return { query: input, missingReference: false };
  if (explicit.size > 1) return { query: input, missingReference: true };

  const entities = new Set(
    history
      .slice(-6)
      .flatMap((message) => mentions(message.text.slice(0, 1000))),
  );
  if (entities.size !== 1) return { query: input, missingReference: true };
  const [entity] = entities;
  return { query: `รุ่น ${entity}\n${input}`, missingReference: false };
}
