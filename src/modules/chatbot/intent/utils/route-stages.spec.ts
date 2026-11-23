import type {
  KnowledgeItem,
  KnowledgeRetrievalResult,
  RouteDecision,
} from '../../../../shared/contracts/chat.types';
import { HANDOFF_INTENT_KEY } from '../../../../shared/knowledge/knowledge-routing.constants';
import { RuleIntentService } from '../rule-intent.service';
import { detectPhatic } from './phatic';
import { decidePhatic } from './phatic-policy';
import {
  decideFromRetrieval,
  gateBeforeSearch,
  isHandoffAnchor,
} from './route-stages';

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

describe('gateBeforeSearch phatic gate', () => {
  const rules = new RuleIntentService();

  /** What the router hands the gates: the phatic verdict is computed outside. */
  const gate = (
    input: string,
    options: {
      inRegister?: boolean;
      lastAct?: 'ASKED' | 'ANSWERED';
    } = {},
  ) => {
    const phatic = detectPhatic(input);
    const verdict = phatic
      ? decidePhatic(phatic.kind, {
          meta: options.lastAct
            ? { lastAct: options.lastAct, lastActAt: 1_000 }
            : {},
          handoffPending: false,
          now: 2_000,
        })
      : null;
    const phaticDecision: RouteDecision | null =
      phatic && verdict
        ? {
            action: 'SMALL_TALK_REPLY',
            intent: 'UNKNOWN',
            confidence: 1,
            source: 'RULE',
            reason: 'test',
            smallTalk: { reply: verdict.reply, kind: phatic.kind },
          }
        : null;

    return gateBeforeSearch({
      input,
      rule: rules.detect(input),
      inRegister: options.inRegister ?? false,
      phaticDecision,
    });
  };

  it('a bare acknowledgement is small talk and never searches', () => {
    expect(gate('ครับ')).toMatchObject({
      kind: 'DECIDE',
      decision: { action: 'SMALL_TALK_REPLY' },
    });
  });

  it('"ครับ" inside a registration flow is form input', () => {
    expect(gate('ครับ', { inRegister: true })).toMatchObject({
      kind: 'DECIDE',
      decision: { action: 'CONTINUE_REGISTER' },
    });
  });

  it('"สวัสดีครับ" still reaches the greeting gate', () => {
    const verdict = gate('สวัสดีครับ');

    expect(verdict).toMatchObject({ kind: 'DECIDE' });
    expect(verdict.kind === 'DECIDE' && verdict.decision.action).not.toBe(
      'SMALL_TALK_REPLY',
    );
  });

  it('"ค่ะ" right after a question steps back to search', () => {
    expect(gate('ค่ะ', { lastAct: 'ASKED' })).toEqual({ kind: 'SEARCH' });
  });

  it('a message with content is not small talk', () => {
    expect(gate('ขอบคุณค่ะ แล้วจองยังไง')).toEqual({ kind: 'SEARCH' });
  });

  it('without a verdict the gates behave as before', () => {
    expect(
      gateBeforeSearch({
        input: 'ครับ',
        rule: rules.detect('ครับ'),
        inRegister: false,
      }),
    ).toEqual({ kind: 'SEARCH' });
  });
});
