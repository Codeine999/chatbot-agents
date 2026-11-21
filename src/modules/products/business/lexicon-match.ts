import { normalizeText } from '../../../utils/text.utils';
import type { BusinessLexicon } from '../attributes/types/attribute-definition.types';

/*
 * Matching of a preset's lexicon against customer text. SUBSTRING compiles the
 * entries as regex fragments (the ECOMMERCE behavior since before presets
 * carried wording); WORD needs whole Thai words, so "สี" never matches "เสีย".
 */

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
export const wordsOf = (text: string): string[] =>
  [...segmenter.segment(normalizeText(text))]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);

function containsPhrase(
  haystack: readonly string[],
  phrase: readonly string[],
): boolean {
  if (!phrase.length) return false;
  for (let i = 0; i + phrase.length <= haystack.length; i++)
    if (phrase.every((word, j) => haystack[i + j] === word)) return true;
  return false;
}

type Matcher = (text: string) => boolean;
const compiled = new WeakMap<
  readonly string[],
  Map<BusinessLexicon['matchMode'], Matcher>
>();

/** Matcher for one signal list under the lexicon's match mode (memoized). */
export function signalMatcher(
  mode: BusinessLexicon['matchMode'],
  list: readonly string[],
): Matcher {
  let byMode = compiled.get(list);
  if (!byMode) {
    byMode = new Map<BusinessLexicon['matchMode'], Matcher>();
    compiled.set(list, byMode);
  }
  const cached = byMode.get(mode);
  if (cached) return cached;
  let matcher: Matcher;
  if (!list.length) matcher = () => false;
  else if (mode === 'SUBSTRING') {
    const pattern = new RegExp(`(${list.join('|')})`, 'iu');
    matcher = (text) => pattern.test(text);
  } else {
    const phrases = list.map(wordsOf).filter((phrase) => phrase.length);
    matcher = (text) => {
      const words = wordsOf(text);
      return phrases.some((phrase) => containsPhrase(words, phrase));
    };
  }
  byMode.set(mode, matcher);
  return matcher;
}

export const matchesSignals = (
  lexicon: BusinessLexicon,
  list: readonly string[],
  text: string,
): boolean => signalMatcher(lexicon.matchMode, list)(text);

/** Whole-message patterns: whitespace is ignored, entries are anchored regex sources. */
export function matchesWholeMessage(
  patterns: readonly string[],
  message: string,
): boolean {
  const text = message.replace(/\s+/gu, '');
  return patterns.some((pattern) => new RegExp(pattern, 'u').test(text));
}

/** Money/count claims every business forbids in prose, whatever its lexicon says. */
const GENERIC_CLAIM = /(?:ราคา\s*(?:คือ|อยู่ที่|เพียง)|\d|บาท)/iu;

/** True when prose (text outside tokens) states a price/count/status the DB must state. */
export function proseMakesClaim(
  lexicon: BusinessLexicon,
  prose: string,
): boolean {
  if (GENERIC_CLAIM.test(prose)) return true;
  const markers = lexicon.claimQuestionMarkers;
  if (!markers?.length)
    return matchesSignals(lexicon, lexicon.claimWords, prose);
  // Sentence by sentence: a question may use the words, a statement may not.
  return prose
    .split(SENTENCE_BREAK)
    .some(
      (sentence) =>
        matchesSignals(lexicon, lexicon.claimWords, sentence) &&
        !matchesSignals(lexicon, markers, sentence),
    );
}
const SENTENCE_BREAK = /[\n?？]+|ค่ะ|คะ|ครับ|คับ/u;
