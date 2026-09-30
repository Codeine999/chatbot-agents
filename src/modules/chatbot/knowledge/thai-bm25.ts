import { normalizeText } from '../../../utils/text.utils';
import type { KnowledgeRecord } from './answer-pattern.service';

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
const FUNCTION_WORDS = new Set([
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

function frequencies(record: KnowledgeRecord): Map<string, number> {
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
  return terms;
}

/** BM25 ranks a bounded, already tenant/language-filtered collection. */
export function bm25Scores(
  query: string,
  records: readonly KnowledgeRecord[],
): number[] {
  const terms = [...new Set(thaiTerms(query))];
  if (!terms.length || !records.length) return records.map(() => 0);
  const documents = records.map(frequencies);
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
      const idf = Math.log(1 + (records.length - hits + 0.5) / (hits + 0.5));
      const denominator =
        frequency + 1.2 * (0.25 + 0.75 * (lengths[index] / averageLength));
      return score + idf * ((frequency * 2.2) / denominator);
    }, 0);
  });
}
