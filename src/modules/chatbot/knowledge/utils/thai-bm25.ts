import { normalizeText } from '../../../../utils/text.utils';
import type { KnowledgeRecord } from '../answer-pattern.service';

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
const STOP_WORDS = new Set([
  'ครับ',
  'ค่ะ',
  'คะ',
  'นะ',
  'หน่อย',
  'the',
  'a',
  'an',
]);

export function thaiTerms(text: string): string[] {
  const normalized = normalizeText(text);
  return [...segmenter.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim())
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

// Keep relation/negation/question words in BM25 scoring, but they cannot
// establish relevance on their own (nor can an isolated number).
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'เป็น',
  'ยัง',
  'ไง',
  'บ้าง',
  'ให้',
  'ที่',
  'ของ',
  'และ',
  'หรือ',
  'ไม่',
  'มี',
  'ได้',
  'ไหม',
  'มั้ย',
  'เท่าไหร่',
  'เท่าไร',
  'เท่า',
  'อย่างไร',
  'อะไร',
  'ยังไง',
  'นี้',
  'นั้น',
  'คือ',
  'ใน',
  'จาก',
  'กับ',
  // Asking/requesting verbs: "อยากสอบถามห้องว่าง" must not make every
  // "สอบถาม..." message a candidate for that FAQ.
  'สอบถาม',
  'ถาม',
  'ขอ',
  'อยาก',
  'รบกวน',
  // Fragments and fillers the ICU segmenter emits ("เท่าไหร่" -> "เท่า"+"ไหร่").
  // Left out, one of them alone made every FAQ with that word a candidate.
  'ไหร่',
  'เมื่อ',
  'มาก',
  'เลย',
  'จัง',
  'แล้ว',
  'จะ',
  'ก็',
  'ตอน',
  'ไป',
  'มา',
  'คุณ',
  'is',
  'are',
  'of',
  'to',
  'and',
  'or',
  'what',
  'how',
  'can',
  'not',
]);

export type Bm25Record = Pick<
  KnowledgeRecord,
  | 'keywords'
  | 'questionExamples'
  | 'title'
  | 'intentKey'
  | 'category'
  | 'description'
  | 'answer'
>;

// Segmenting Thai is the dominant cost of lexical search. Rows of the
// in-memory knowledge snapshot keep their identity between messages, so each
// is segmented once per snapshot; the entry is collected with its row.
const frequencyCache = new WeakMap<Bm25Record, Map<string, number>>();

function frequencies(record: Bm25Record): Map<string, number> {
  const cached = frequencyCache.get(record);
  if (cached) return cached;
  const fields: readonly [string, number][] = [
    [record.keywords.join(' '), 4],
    [record.questionExamples.join(' '), 3],
    [record.title, 2],
    [record.intentKey ?? '', 2],
    [record.category ?? '', 1],
    [record.description ?? '', 1],
    [record.answer, 1],
  ];
  const terms = new Map<string, number>();
  for (const [value, weight] of fields) {
    for (const term of thaiTerms(value))
      terms.set(term, (terms.get(term) ?? 0) + weight);
  }
  frequencyCache.set(record, terms);
  return terms;
}

/**
 * IDF-weighted share (0..1) of the query's content terms found in each record.
 * BM25 is unbounded and corpus-relative, so it cannot say "this candidate
 * shares almost nothing with the question". Weighting by IDF keeps one generic
 * word ("วัน", "หนึ่ง") from counting as most of a short question. Terms that
 * appear in no record at all ("กี่โมง" against a KB that never says it) cannot
 * tell candidates apart, so they are left out of the denominator.
 */
export function termCoverages(
  query: string,
  records: readonly Bm25Record[],
): number[] {
  return coverageOver(query, records.map(frequencies));
}

type Documents = readonly Map<string, number>[];

function coverageOver(query: string, documents: Documents): number[] {
  const terms = [...new Set(thaiTerms(query))].filter(
    (term) => !FUNCTION_WORDS.has(term) && !/^\d+$/u.test(term),
  );
  if (!terms.length || !documents.length) return documents.map(() => 0);
  const idf = new Map<string, number>();
  for (const term of terms) {
    const hits = documents.filter((doc) => doc.has(term)).length;
    if (hits)
      idf.set(
        term,
        Math.log(1 + (documents.length - hits + 0.5) / (hits + 0.5)),
      );
  }
  const total = [...idf.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return documents.map(() => 0);
  return documents.map(
    (doc) =>
      [...idf].reduce(
        (sum, [term, weight]) => sum + (doc.has(term) ? weight : 0),
        0,
      ) / total,
  );
}

/** BM25 ranks a bounded, already tenant/language-filtered collection. */
export function bm25Scores(
  query: string,
  records: readonly Bm25Record[],
): number[] {
  return scoreOver(query, records.map(frequencies));
}

/** Scores and coverage from one pass over the records (segmenting is the cost). */
export function bm25Match(
  query: string,
  records: readonly Bm25Record[],
): { scores: number[]; coverages: number[] } {
  const documents = records.map(frequencies);
  return {
    scores: scoreOver(query, documents),
    coverages: coverageOver(query, documents),
  };
}

function scoreOver(query: string, documents: Documents): number[] {
  const terms = [...new Set(thaiTerms(query))];
  if (!terms.length || !documents.length) return documents.map(() => 0);
  const lengths = documents.map((doc) =>
    [...doc.values()].reduce((sum, value) => sum + value, 0),
  );
  const averageLength =
    lengths.reduce((sum, value) => sum + value, 0) / documents.length || 1;
  const documentFrequency = new Map(
    terms.map((term) => [
      term,
      documents.filter((doc) => doc.has(term)).length,
    ]),
  );
  return documents.map((doc, index) => {
    if (
      !terms.some(
        (term) =>
          doc.has(term) && !FUNCTION_WORDS.has(term) && !/^\d+$/u.test(term),
      )
    ) {
      return 0;
    }
    return terms.reduce((score, term) => {
      const frequency = doc.get(term) ?? 0;
      if (!frequency) return score;
      const hits = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - hits + 0.5) / (hits + 0.5));
      const denominator =
        frequency + 1.2 * (0.25 + 0.75 * (lengths[index] / averageLength));
      return score + idf * ((frequency * 2.2) / denominator);
    }, 0);
  });
}
