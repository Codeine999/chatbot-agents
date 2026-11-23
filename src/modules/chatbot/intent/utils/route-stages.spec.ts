import type {
  KnowledgeItem,
  KnowledgeRetrievalResult,
} from '../../../../shared/contracts/chat.types';
import { HANDOFF_INTENT_KEY } from '../../../../shared/knowledge/knowledge-routing.constants';
import { decideFromRetrieval, isHandoffAnchor } from './route-stages';

const item = (intentKey: string | null, id = 'p1'): KnowledgeItem => ({
  source: 'ANSWER_PATTERN',
  id,
  title: id,
  content: id,
  answer: 'รับทราบค่ะ กำลังติดต่อเจ้าหน้าที่',
  score: 1,
  metadata: { intentKey, exactMatch: true, safeDirect: true },
});

const retrieval = (
  route: KnowledgeRetrievalResult['route'],
  selectedItems: KnowledgeItem[],
): KnowledgeRetrievalResult =>
  ({
    route,
    items: selectedItems,
    selectedItems,
    topScores: [],
    scoreGap: null,
    matchType: 'EXACT',
  }) as unknown as KnowledgeRetrievalResult;

describe('decideFromRetrieval handoff intent', () => {
  it.each(['DIRECT', 'RAG'] as const)(
    'a %s hit on the handoff row hands off for real',
    (route) => {
      const decision = decideFromRetrieval(
        retrieval(route, [item(HANDOFF_INTENT_KEY)]),
        'ขอสายเจ้าหน้าที่หน่อย',
      );

      expect(decision).toMatchObject({
        action: 'CONTACT_ADMIN',
        intent: 'CONTACT_ADMIN',
        source: 'DATABASE',
        reason: 'knowledge intent contact.admin → system handoff',
      });
      expect(decision?.businessFallback).toBeUndefined();
    },
  );

  it('only the top item decides', () => {
    const decision = decideFromRetrieval(
      retrieval('RAG', [item(null, 'a'), item(HANDOFF_INTENT_KEY, 'b')]),
      'ค่าส่งเท่าไหร่',
    );

    expect(decision?.action).toBe('ANSWER_KNOWLEDGE');
  });

  it('a LOW_CONFIDENCE hit goes to the classifier instead', () => {
    expect(
      decideFromRetrieval(
        retrieval('LOW_CONFIDENCE', [item(HANDOFF_INTENT_KEY)]),
        'ขอสายเจ้าหน้าที่หน่อย',
      ),
    ).toBeNull();
  });

  it('a conflict still wins over the handoff row', () => {
    const conflicted = {
      ...retrieval('RAG', [item(HANDOFF_INTENT_KEY)]),
      fallbackReason: 'CONFLICTING_CANDIDATES',
    } as KnowledgeRetrievalResult;

    expect(decideFromRetrieval(conflicted, 'x')?.businessFallback).toBe(true);
  });

  it('isHandoffAnchor ignores other keys and missing items', () => {
    expect(isHandoffAnchor(item('contact.sales'))).toBe(false);
    expect(isHandoffAnchor(item(null))).toBe(false);
    expect(isHandoffAnchor(undefined)).toBe(false);
  });
});
