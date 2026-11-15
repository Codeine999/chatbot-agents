import { normalizeText } from '../../utils/text.utils';
import { RRF_RANK_CONSTANT } from '../../shared/knowledge/knowledge-routing.constants';
import type {
  KnowledgeItem,
  KnowledgeMatchType,
  KnowledgeRetrievalResult,
  RetrievalFallbackReason,
} from '../../shared/contracts/chat.types';

/**
 * Stateless ranking and evidence checks of KnowledgeRetrievalService: nothing
 * here reads configuration or does I/O, so each function is testable alone.
 */

/** BM25 scores from different corpora are ranked separately before RRF. */
export function rankCandidates(
  lexical: KnowledgeItem[],
  vectors: KnowledgeItem[],
): KnowledgeItem[] {
  const lists = [
    ...(['ANSWER_PATTERN', 'MICRO_KNOWLEDGE'] as const).map((source) =>
      lexical
        .filter((item) => item.source === source)
        .sort(
          (a, b) =>
            rawMetric(b, 'rawScore') - rawMetric(a, 'rawScore') ||
            tieBreak(a, b),
        ),
    ),
    [...vectors].sort(
      (a, b) =>
        rawMetric(b, 'vectorSimilarity') - rawMetric(a, 'vectorSimilarity') ||
        tieBreak(a, b),
    ),
  ];
  const merged = new Map<string, KnowledgeItem>();
  for (const [channel, list] of lists.entries()) {
    const seen = new Set<string>();
    for (const [index, item] of list.entries()) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = merged.get(key);
      merged.set(key, {
        ...item,
        // Lexical DB content wins over a vector hit for the same source/ID.
        ...previous,
        score: (previous?.score ?? 0) + 1 / (RRF_RANK_CONSTANT + index + 1),
        metadata: {
          ...previous?.metadata,
          ...item.metadata,
          exactMatch:
            previous?.metadata?.exactMatch === true ||
            item.metadata?.exactMatch === true,
          matchTypes: [
            ...new Set([
              ...((previous?.metadata?.matchTypes as string[]) ?? []),
              channel === 2 ? 'EMBEDDING' : 'KEYWORD',
            ]),
          ],
        },
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.score - a.score || tieBreak(a, b),
  );
}

export function hasConflicts(items: readonly KnowledgeItem[]): boolean {
  if (items.some((item) => item.metadata?.conflicting === true)) return true;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (itemKey(a) === itemKey(b)) continue;
      if (!isRelated(a, b)) continue;
      const left = normalizeText(a.answer ?? '');
      const right = normalizeText(b.answer ?? '');
      if (left === right) continue;
      // A changed value in the same keyed assertion is a conflict even when
      // both versions describe a condition (e.g. free over 500 vs 700).
      const numericTemplate = (text: string) =>
        text.replace(/\d+(?:[.,]\d+)*/gu, '#');
      if (
        /\d/u.test(left) &&
        /\d/u.test(right) &&
        numericTemplate(left) === numericTemplate(right)
      )
        return true;
      // Different conditional cases are not competing unconditional facts.
      // Leave their interpretation to grounded answering (or its sentinel).
      const conditional =
        /ถ้า|เมื่อ|กรณี|สำหรับ|ซื้อ|ตั้งแต่|มากกว่า|น้อยกว่า|\b(?:if|when|for|over|under)\b/u;
      if (conditional.test(left) || conditional.test(right)) continue;
      // A narrow, same-assertion polarity check, not "same category + close score".
      const pa = parseAssertion(left);
      const pb = parseAssertion(right);
      if (pa.fact === pb.fact && pa.negative !== pb.negative) return true;
    }
  }
  return false;
}

export function isRelated(a: KnowledgeItem, b: KnowledgeItem): boolean {
  if (itemKey(a) === itemKey(b)) return true;
  const entityA = a.metadata?.entityKey;
  const entityB = b.metadata?.entityKey;
  const topicA = a.metadata?.topicKey;
  const topicB = b.metadata?.topicKey;
  if (entityA && entityB && entityA !== entityB) return false;
  if (topicA && topicB && topicA !== topicB) return false;
  if (entityA && entityB && topicA && topicB) return true;
  return (
    sharesQuestion(a, b) ||
    Boolean(a.title && normalizeText(a.title) === normalizeText(b.title ?? ''))
  );
}

function parseAssertion(text: string): { fact: string; negative: boolean } {
  // Normalize only explicit negations with an otherwise identical assertion.
  // Different wording/conditions are not enough to infer a contradiction.
  const replacements: readonly (readonly [RegExp, string])[] = [
    [/ไม่ได้/gu, 'ได้'],
    [/ไม่รองรับ/gu, 'รองรับ'],
    [/ไม่อนุญาต/gu, 'อนุญาต'],
    [/ไม่สามารถ/gu, 'สามารถ'],
    [/ห้ามซัก/gu, 'ซักได้'],
    [/\b(?:cannot|can not)\b/gu, 'can'],
    [/\bmust not be washed\b/gu, 'can be washed'],
    [/\bis not\b/gu, 'is'],
    [/\bare not\b/gu, 'are'],
    [/\bnot supported\b/gu, 'supported'],
  ];
  let fact = text;
  for (const [pattern, positive] of replacements)
    fact = fact.replace(pattern, positive);
  return { fact, negative: fact !== text };
}

function sharesQuestion(a: KnowledgeItem, b: KnowledgeItem): boolean {
  const questions = (item: KnowledgeItem) =>
    Array.isArray(item.metadata?.questionExamples)
      ? (item.metadata.questionExamples as string[])
          .map(normalizeText)
          .filter(Boolean)
      : [];
  const left = new Set(questions(a));
  return questions(b).some((question) => left.has(question));
}

export function itemKey(item: KnowledgeItem): string {
  return `${item.source}:${item.id}`;
}

/** Candidates built without coverage (older callers) are not filtered. */
export function lexicalCoverage(item: KnowledgeItem): number {
  const value = item.metadata?.lexicalCoverage;
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

export function rawMetric(item: KnowledgeItem, key: string): number {
  const value = item.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function tieBreak(a: KnowledgeItem, b: KnowledgeItem): number {
  return (
    rawMetric(b, 'priority') - rawMetric(a, 'priority') ||
    itemKey(a).localeCompare(itemKey(b))
  );
}

export function retrievalResult(
  items: readonly KnowledgeItem[],
  selectedItems: readonly KnowledgeItem[],
  route: KnowledgeRetrievalResult['route'],
  fallbackReason?: RetrievalFallbackReason,
): KnowledgeRetrievalResult {
  const top = selectedItems[0] ?? items[0];
  const types = top?.metadata?.matchTypes as string[] | undefined;
  const matchType: KnowledgeMatchType = top?.metadata?.safeDirect
    ? 'EXACT'
    : types?.includes('KEYWORD') && types.includes('EMBEDDING')
      ? 'HYBRID'
      : types?.includes('EMBEDDING')
        ? 'EMBEDDING'
        : top
          ? 'KEYWORD'
          : 'NONE';
  return {
    route,
    items,
    selectedItems,
    matchType,
    fallbackReason,
    topScores: items.map((item) => item.score),
    scoreGap: items.length > 1 ? items[0].score - items[1].score : null,
  };
}
