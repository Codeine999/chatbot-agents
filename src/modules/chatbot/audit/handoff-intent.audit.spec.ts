/**
 * Audit: a request for a human must reach `requestAdmin`, whatever the wording
 * and whatever the knowledge base says. Regression for the 2026-11-23 case where
 * a KB row answered "กำลังติดต่อเจ้าหน้าที่" and nobody was ever notified.
 */
import { buildHarness, pattern, vector } from './core-chat.harness';
import { ReplyTemplateService } from '../../../shared/templates/answer-template.service';

const ask = (text: string) => ({
  userId: 'U1',
  text,
  conversationId: 'c1',
  turnId: 't1',
});

const FAKE_HANDOFF_TEXT =
  'รับทราบค่ะ กำลังติดต่อเจ้าหน้าที่ให้เข้ามาดูแลในแชทนี้';

/** Wordings the keyword rule catches before any search. */
const KEYWORD_PHRASES = [
  'ขอคุยกับพนักงาน',
  'ขอคุยกับเจ้าหน้าที่ค่ะ',
  'ติดต่อแอดมินหน่อย',
  'ติดต่อเจ้าหน้าที่ได้ไหมคะ',
  'ติดต่อพนักงานยังไง',
  'คุยกับแอดมินได้ไหม',
  'ขอเจ้าหน้าที่หน่อย',
  'ขอพนักงานมาคุยหน่อยครับ',
  'ขอคนจริงมาคุยหน่อย',
  'อยากคุยกับคนจริงๆ',
  'แจ้งปัญหาหน่อยค่ะ',
  'ขอคุยกับแอดมินหน่อย',
];

/** Wordings only the knowledge row (its question examples) can catch. */
const KNOWLEDGE_PHRASES = [
  'ขอสายเจ้าหน้าที่หน่อย',
  'ต่อสายพนักงานให้หน่อย',
  'ไม่อยากคุยกับบอท',
  'เรียกคนมาตอบหน่อย',
];

const handoffRow = () =>
  pattern({
    id: 'p-handoff',
    title: 'ติดต่อเจ้าหน้าที่แชท',
    intentKey: 'contact.admin',
    questionExamples: KNOWLEDGE_PHRASES,
    answer: FAKE_HANDOFF_TEXT,
    renderMode: 'DIRECT',
  });

describe('A request for a human always hands off', () => {
  it('"ขอคุยกับพนักงาน" requests an admin and answers with the real handoff text', async () => {
    const harness = buildHarness({ patterns: [handoffRow()] });

    const response = await harness.chatbot.handleTextMessage(
      ask('ขอคุยกับพนักงาน'),
    );

    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'waiting_admin' } }),
    );
    expect(response.text).toBe(new ReplyTemplateService().contactAdmin());
    expect(response.source).toBe('RULE');
    expect(response.text).not.toContain('กำลังติดต่อ');
    expect(harness.spies.generate).not.toHaveBeenCalled();
  });

  it.each([...KEYWORD_PHRASES, ...KNOWLEDGE_PHRASES])(
    '"%s" requests an admin with no LLM call',
    async (text) => {
      const harness = buildHarness({ patterns: [handoffRow()] });

      const response = await harness.chatbot.handleTextMessage(ask(text));

      expect(harness.spies.conversationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'waiting_admin' } }),
      );
      expect(response.text).toBe(new ReplyTemplateService().contactAdmin());
      expect(response.text).not.toContain(FAKE_HANDOFF_TEXT);
      expect(harness.spies.generate).not.toHaveBeenCalled();
    },
  );

  it('a handoff row reached through the classifier path also hands off', async () => {
    // Vector-only hit below the confidence gate: the classifier says BUSINESS,
    // and the top evidence is the handoff row.
    const harness = buildHarness({
      env: { KNOWLEDGE_RAG_MIN_VECTOR_SIMILARITY: '0.75' },
      patterns: [],
      patternVectors: [
        vector({
          id: 'p-handoff',
          title: 'ติดต่อเจ้าหน้าที่แชท',
          intentKey: 'contact.admin',
          answer: FAKE_HANDOFF_TEXT,
          score: 0.68,
        }),
      ],
      generations: ['{"classification":"BUSINESS","confidence":0.8}'],
    });

    const response = await harness.chatbot.handleTextMessage(
      ask('อยากให้มีคนมาช่วยดูเรื่องนี้หน่อย'),
    );

    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'waiting_admin' } }),
    );
    expect(response.text).toBe(new ReplyTemplateService().contactAdmin());
  });
});

describe('The handoff row never reaches the grounded prompt', () => {
  it('is dropped from the evidence while other rows stay', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-ship',
          title: 'ค่าส่ง',
          keywords: ['ค่าส่ง'],
          questionExamples: ['ค่าส่งเท่าไหร่'],
          answer: 'ค่าส่ง 50 บาท',
          renderMode: 'REWRITE',
        }),
        pattern({
          id: 'p-handoff',
          title: 'ติดต่อเจ้าหน้าที่แชท',
          intentKey: 'contact.admin',
          keywords: ['ค่าส่ง'],
          answer: FAKE_HANDOFF_TEXT,
          renderMode: 'REWRITE',
        }),
      ],
      generations: ['ค่าส่ง 50 บาทค่ะ'],
    });

    await harness.chatbot.handleTextMessage(ask('ค่าส่งเท่าไหร่'));

    const ids = harness.ragContext().map((entry) => entry.id);
    expect(ids).toContain('p-ship');
    expect(ids).not.toContain('p-handoff');
    expect(harness.systemInstruction()).not.toContain(FAKE_HANDOFF_TEXT);
  });
});
