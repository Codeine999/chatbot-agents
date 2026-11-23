/**
 * Phatic detector: is the whole message nothing but an acknowledgement,
 * thanks, farewell, nudge or polite particle ("ครับ", "ครัค่ะ", "👍", "??")?
 *
 * Pure and deliberately narrow. It answers "yes" only when every character is
 * explained by the lexicon below, and says null at the first doubt: a message
 * with any content word, digit, question word or unknown emoji is not phatic.
 * No edit distance: a typo is accepted only if it is listed.
 *
 * Whether the reply should be sent at all depends on the conversation state;
 * that is `decidePhatic` (phatic-policy.ts), not this file.
 */
export type PhaticKind =
  | 'PARTICLE_ONLY'
  | 'ACK'
  | 'THANKS'
  | 'CLOSING'
  | 'PING'
  | 'LAUGH';

type Category = 'PARTICLE' | 'ACK' | 'THANKS' | 'CLOSING' | 'PING';

/** Polite sentence-final particles. Lower case; Latin forms included. */
const PARTICLES = [
  'ครับ',
  'ครับผม',
  'คับ',
  'ค้าบ',
  'คร้าบ',
  'ครัช',
  'ขรับ',
  'ฮะ',
  'ฮับ',
  'ค่ะ',
  'คะ',
  'ค่า',
  'ค้า',
  'คร่ะ',
  'จ้า',
  'จ้ะ',
  'จ๊ะ',
  'นะ',
  'นะคะ',
  'นะครับ',
  'เด้อ',
  'เน้อ',
  'krub',
  'kub',
  'ka',
  'kha',
] as const;

/** Typos seen in real chats. Matched as whole words, never by distance. */
const TYPOS = [
  'ครัค่ะ',
  'ค่ร่ะ',
  'คับค่ะ',
  'ครับค่ะ',
  'คัฟ',
  'ครัฟ',
  'คาบ',
] as const;

const ACKS = [
  'โอเค',
  'โอเช',
  'ok',
  'okay',
  'oke',
  'รับทราบ',
  'ทราบแล้ว',
  'เข้าใจแล้ว',
  'อืม',
  'อือ',
  'อ๋อ',
  'อ่อ',
  'อ้อ',
] as const;

const THANKS = [
  'ขอบคุณ',
  'ขอบคุณมาก',
  'ขอบใจ',
  'ขอบพระคุณ',
  'thx',
  'thanks',
  'thankyou',
  'ty',
] as const;

const CLOSINGS = ['บาย', 'บ๊ายบาย', 'แค่นี้ก่อน', 'แค่นี้แหละ'] as const;

/** Contain "ไหม" on purpose: matched before the question-word blocklist and the "?" check. */
const PINGS = ['ฮัลโหล', 'hello', 'ยังอยู่ไหม', 'มีใครอยู่ไหม'] as const;

/**
 * Words that make a message a question. "ได้", "ใช่", "ไม่", "เค" are not
 * phatic either (they answer a question or an offer), simply by being absent
 * from the lexicon above.
 */
const QUESTION_WORDS = [
  'ไหม',
  'มั้ย',
  'ม้าย',
  'มั๊ย',
  'ปะ',
  'ป่ะ',
  'ป่าว',
  'เปล่า',
  'กี่',
  'ไหน',
  'อะไร',
  'ยังไง',
  'อย่างไร',
  'เท่าไร',
  'เท่าไหร่',
  'หรอ',
  'เหรอ',
  'เมื่อไร',
  'เมื่อไหร่',
  'ทำไม',
  'ไง',
] as const;

/** Emoji that carry no content. Anything else pictographic means "not phatic". */
const SAFE_EMOJI = ['👍', '👌', '🙏', '🙂', '😊', '☺'] as const;

/**
 * "ค่าาาา" -> "ค่า". A stretched word is matched on a collapsed copy of the
 * message against a collapsed lexicon, so "hello" still matches "hellooo".
 */
const collapse = (value: string) => value.replace(/(.)\1+/gsu, '$1');

const LEXICON: readonly (readonly [string, Category])[] = [
  ...PARTICLES.map((word) => [word, 'PARTICLE'] as const),
  ...TYPOS.map((word) => [word, 'PARTICLE'] as const),
  ...ACKS.map((word) => [word, 'ACK'] as const),
  ...THANKS.map((word) => [word, 'THANKS'] as const),
  ...CLOSINGS.map((word) => [word, 'CLOSING'] as const),
  ...PINGS.map((word) => [word, 'PING'] as const),
];

const longestFirst = (entries: readonly (readonly [string, Category])[]) =>
  [...entries].sort((a, b) => b[0].length - a[0].length);

const RAW_ENTRIES = longestFirst(LEXICON);
const COLLAPSED_ENTRIES = longestFirst(
  LEXICON.map(([word, category]) => [collapse(word), category] as const),
);

const COLLAPSED_PINGS = PINGS.map(collapse);

/**
 * Cut-off particles ("ครั" in "ครัค่ะ"): proper prefixes, at least two code
 * points, of a real particle. Longest first.
 */
const PARTICLE_PREFIXES: readonly string[] = [
  ...new Set(
    PARTICLES.flatMap((word) =>
      Array.from({ length: Math.max(0, word.length - 2) }, (_, i) =>
        word.slice(0, i + 2),
      ),
    ),
  ),
].sort((a, b) => b.length - a.length);

const KIND_PRIORITY: readonly [Category, PhaticKind][] = [
  ['THANKS', 'THANKS'],
  ['CLOSING', 'CLOSING'],
  ['PING', 'PING'],
  ['ACK', 'ACK'],
  ['PARTICLE', 'PARTICLE_ONLY'],
];

const LAUGH = /^5{3,}$/u;

export function detectPhatic(text: string): { kind: PhaticKind } | null {
  // 1. normalize; spaces, ZWJ and variation selectors never carry meaning.
  const normalized = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?:\s|\u200D|\uFE0F)+/gu, '');
  if (!normalized) return null;

  // 2. digits mean content ("ok 2 คน"); only a run of 555 is laughter.
  if (LAUGH.test(normalized)) return { kind: 'LAUGH' };
  if (/\p{Nd}/u.test(normalized)) return null;

  // 3. emoji: only content-free ones, remembered and then dropped.
  const emoji: string[] = normalized.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.some((item) => !SAFE_EMOJI.some((safe) => item === safe))) {
    return null;
  }

  // 4. punctuation is dropped, but a "?" is remembered.
  const hasQuestionMark = /[?？]/u.test(normalized);
  const letters = normalized
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{P}/gu, '');
  if (!letters) {
    if (hasQuestionMark) return { kind: 'PING' };
    if (emoji.includes('🙏')) return { kind: 'THANKS' };
    return emoji.length ? { kind: 'ACK' } : null;
  }
  // "ยังอยู่ไหม?", "ฮัลโหล?": a nudge is still a nudge with a question mark;
  // any other "?" makes the message a question.
  if (hasQuestionMark) return isPingOnly(letters) ? { kind: 'PING' } : null;

  // 5. stretched letters are shortened, on a copy used only for matching.
  //    The message is tried as typed first: collapsing would break a real
  //    double letter at a word boundary ("โอเค"+"ค่ะ", "ก่อน"+"นะ").
  const collapsed = collapse(letters);

  // 6. a question word means a question, except inside a PING phrase.
  if (hasQuestionWord(collapsed)) return null;

  // 7. every character must be explained by the lexicon.
  const categories =
    segment(letters, RAW_ENTRIES) ?? segment(collapsed, COLLAPSED_ENTRIES);
  if (!categories?.length) return null;

  // 8. the strongest category present names the kind.
  const kind = KIND_PRIORITY.find(([category]) =>
    categories.includes(category),
  );
  return kind ? { kind: kind[1] } : null;
}

/** Only nudge phrases and particles ("ยังอยู่ไหมคะ", "ฮัลโหลครับ"). */
function isPingOnly(letters: string): boolean {
  const categories =
    segment(letters, RAW_ENTRIES) ??
    segment(collapse(letters), COLLAPSED_ENTRIES);
  return (
    !!categories?.includes('PING') &&
    categories.every(
      (category) => category === 'PING' || category === 'PARTICLE',
    )
  );
}

function hasQuestionWord(text: string): boolean {
  let rest = text;
  for (const ping of COLLAPSED_PINGS) rest = rest.split(ping).join('\u0000');
  return QUESTION_WORDS.some((word) => rest.includes(word));
}

/** Longest-match split with backtracking; null when any character is left over. */
function segment(
  text: string,
  entries: readonly (readonly [string, Category])[],
): Category[] | null {
  const failed = new Set<number>();

  const from = (index: number): Category[] | null => {
    if (index === text.length) return [];
    if (failed.has(index)) return null;

    for (const [word, category] of entries) {
      if (!text.startsWith(word, index)) continue;
      const rest = from(index + word.length);
      if (rest) return [category, ...rest];
    }

    for (const prefix of PARTICLE_PREFIXES) {
      if (!text.startsWith(prefix, index)) continue;
      const next = index + prefix.length;
      if (!startsWithParticle(text, next)) continue;
      const rest = from(next);
      if (rest) return ['PARTICLE', ...rest];
    }

    failed.add(index);
    return null;
  };

  return from(0);
}

function startsWithParticle(text: string, index: number): boolean {
  return PARTICLES.some((word) => text.startsWith(word, index));
}
