/**
 * Audit: a bare acknowledgement ("ครับ", "👍", "??") is answered from room
 * state with no retrieval and no model, and a message that carries content is
 * never mistaken for one. Replays the 2026-11-23 conversation from
 * docs/turn-understanding-plan.md §1.
 */
import { buildHarness, pattern, type Harness } from './core-chat.harness';
import { PARTIAL_ANSWER_NOTE } from '../../ai/prompt/ai-chat.constants';
import { CLARIFY_MESSAGE } from '../../../shared/knowledge/knowledge-routing.constants';
import { ReplyTemplateService } from '../../../shared/templates/answer-template.service';
import type {
  AiAnswerResult,
  ChatResponse,
  RouteDecision,
} from '../../../shared/contracts/chat.types';

const ON = { PHATIC_FAST_PATH_ENABLED: 'true' };
const templates = new ReplyTemplateService();
const HOUR = 3_600_000;
const MINUTE = 60_000;

let turn = 0;
const ask = (text: string, extra: Record<string, unknown> = {}) => ({
  userId: 'U1',
  text,
  conversationId: 'c1',
  turnId: `t${++turn}`,
  ...extra,
});

/** A controllable server clock; every TurnMeta time and policy window reads it. */
let clock = 0;
beforeEach(() => {
  clock = Date.UTC(2026, 10, 23, 4, 38); // 11:38 in Bangkok
  turn = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

/** One customer turn followed by the delivery step that records what was sent. */
async function say(
  harness: Harness,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ChatResponse> {
  const response = await harness.chatbot.handleTextMessage(ask(text, extra));
  await harness.deliver('c1', response);
  return response;
}

const noModelCalls = (harness: Harness) => {
  expect(harness.spies.generate).not.toHaveBeenCalled();
  expect(harness.spies.embedQuery).not.toHaveBeenCalled();
};

const timetable = () =>
  pattern({
    id: 'timetable',
    title: 'ตารางรอบรถ',
    keywords: ['รอบรถ'],
    questionExamples: ['รอบรถ กรุงเทพ พัทยา'],
    answer: 'ตารางรอบรถ',
    renderMode: 'DIRECT',
  });

describe('The conversation from the plan, §1', () => {
  it('hands off for real, then answers a nudge once and stays quiet after it', async () => {
    const harness = buildHarness({ env: ON, patterns: [timetable()] });

    // 11:38 the customer asks for a person: a real handoff, not a KB text.
    const handoff = await say(harness, 'ขอคุยกับพนักงาน');
    expect(handoff.text).toBe(templates.contactAdmin());
    expect(handoff.assistantAct).toBe('HANDOFF_NOTICE');
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'waiting_admin' } }),
    );
    expect(harness.spies.notifyAdminRequired).toHaveBeenCalledTimes(1);

    // 11:38 an ordinary question is still answered while waiting for staff.
    clock += MINUTE;
    const times = await say(harness, 'รอบรถ กรุงเทพ พัทยา', {
      handoffPending: true,
    });
    expect(times.text).toBe('ตารางรอบรถ');
    expect(times.assistantAct).toBe('ANSWERED');

    const embeddingsBefore = harness.spies.embedQuery.mock.calls.length;

    // 17:49 six hours later the customer nudges: told once that staff know.
    clock += 6 * HOUR;
    const nudge = await say(harness, 'ครัค่ะ', { handoffPending: true });
    expect(nudge).toEqual({
      text: templates.handoffWaiting('ค่ะ'),
      source: 'RULE',
      contextPolicy: 'EXCLUDE',
      assistantAct: 'HANDOFF_NOTICE',
    });

    // 17:49 a second nudge a moment later is not answered again.
    clock += 5_000;
    const again = await say(harness, 'ครับ', { handoffPending: true });
    expect(again.text).toBe('');
    expect(again.contextPolicy).toBe('EXCLUDE');

    // The last two turns cost nothing: no model and no embedding.
    expect(harness.spies.generate).not.toHaveBeenCalled();
    expect(harness.spies.embedQuery.mock.calls).toHaveLength(embeddingsBefore);
    // Staff were told once, at 11:38, and never again.
    expect(harness.spies.notifyAdminRequired).toHaveBeenCalledTimes(1);
  });

  it('says it again once the cooldown has passed', async () => {
    const harness = buildHarness({ env: ON, patterns: [timetable()] });
    await say(harness, 'ขอคุยกับพนักงาน');
    clock += 6 * HOUR;
    await say(harness, 'ครัค่ะ', { handoffPending: true });

    clock += 16 * MINUTE;
    const nudge = await say(harness, '??', { handoffPending: true });

    expect(nudge.text).toBe(templates.handoffWaiting('ค่ะ'));
    noModelCalls(harness);
  });

  it('does not say staff are coming when the handoff is too old to vouch for', async () => {
    const harness = buildHarness({ env: ON });
    await say(harness, 'ขอคุยกับพนักงาน');

    clock += 25 * HOUR;
    const nudge = await say(harness, 'ครับ', { handoffPending: true });

    expect(nudge.text).toBe(templates.ack('ค่ะ'));
    expect(nudge.text).not.toContain('เจ้าหน้าที่');
  });
});

describe('Use cases answered with no model', () => {
  it('U1: thanks and acknowledgement after an answer get one short reply, then silence', async () => {
    const harness = buildHarness({ env: ON, patterns: [timetable()] });
    await say(harness, 'รอบรถ กรุงเทพ พัทยา');
    const embeddingsBefore = harness.spies.embedQuery.mock.calls.length;

    clock += MINUTE;
    const first = await say(harness, 'โอเคค่ะ');
    expect(first).toEqual({
      text: templates.ack('ค่ะ'),
      source: 'RULE',
      contextPolicy: 'EXCLUDE',
      assistantAct: 'ACKED',
    });
    expect(first.text).not.toMatch(/สวัสดี/);

    clock += MINUTE;
    expect((await say(harness, '👍')).text).toBe('');
    expect(harness.spies.embedQuery.mock.calls).toHaveLength(embeddingsBefore);
    expect(harness.spies.generate).not.toHaveBeenCalled();
  });

  it('U2: closing words get the thanks template', async () => {
    const harness = buildHarness({ env: ON });

    expect((await say(harness, 'ขอบคุณค่ะ')).text).toBe(
      templates.thanks('ค่ะ'),
    );
    clock += MINUTE;
    // An acknowledgement of an acknowledgement is not answered.
    expect((await say(harness, 'แค่นี้ก่อนนะคะ')).text).toBe('');
    noModelCalls(harness);
  });

  it('U4: a bare "ครับ" after a long silence is acknowledged without a greeting', async () => {
    const harness = buildHarness({ env: ON });

    const response = await say(harness, 'ครับ');

    expect(response.text).toBe(templates.ack('ค่ะ'));
    expect(response.text).not.toMatch(/สวัสดี/);
    noModelCalls(harness);
  });

  it.each(['ครัค่ะ', 'ค่ร่ะ', 'คับบบ', 'kub', '555'])(
    'U17: the slang "%s" is a particle, answered without a model',
    async (text) => {
      const harness = buildHarness({ env: ON });

      const response = await say(harness, text);

      expect(response.source).toBe('RULE');
      expect(response.contextPolicy).toBe('EXCLUDE');
      noModelCalls(harness);
    },
  );

  it('U18: while an admin is talking, a bare thanks is theirs and gets no reply', async () => {
    const harness = buildHarness({ env: ON });
    await harness.turnMeta.markAssistant('c1', 'ANSWERED');
    clock += MINUTE;
    await harness.turnMeta.markAdmin('c1');

    clock += MINUTE;
    const response = await say(harness, 'ขอบคุณครับ');

    expect(response.text).toBe('');
    noModelCalls(harness);
  });

  it('U18: a message with content for the admin still takes the normal route', async () => {
    const harness = buildHarness({
      env: ON,
      generations: [
        '{"classification":"GENERAL","confidence":0.9}',
        'ได้เลยค่ะ',
      ],
    });
    await harness.turnMeta.markAdmin('c1');

    clock += MINUTE;
    const response = await say(harness, 'ขอบคุณครับ ขอเลื่อนเป็นพรุ่งนี้');

    expect(response.text).not.toBe('');
    expect(harness.spies.embedQuery).toHaveBeenCalled();
  });

  it('keeps the reply out of the chat context', async () => {
    const harness = buildHarness({ env: ON });

    const response = await say(harness, 'ขอบคุณค่ะ');

    expect(response.contextPolicy).toBe('EXCLUDE');
    expect(response.source).toBe('RULE');
  });

  it('uses the persona particle when the tenant locked one', async () => {
    const harness = buildHarness({
      env: ON,
      aiSetting: {
        systemPrompt: null,
        fallbackMessage: null,
        promptVersion: 1,
        responseStyle: {
          targetLength: 'adaptive',
          emojiLevel: 'light',
          politeParticle: 'ครับ',
        },
      },
    });

    const response = await say(harness, 'ครับ');

    expect(response.text).toBe(templates.ack('ครับ'));
    expect(response.text).not.toContain('นะคะ');
  });
});

describe('A message that carries content is never small talk', () => {
  it.each([
    'ขอบคุณค่ะ แล้วจองยังไง', // U11
    'ครับ แล้วราคาล่ะ',
    'ok 2 คน',
    'ได้ปะ',
    'ใช่ค่ะ',
    'โอเคไหม',
  ])('"%s" is routed normally', async (text) => {
    const harness = buildHarness({
      env: ON,
      generations: ['{"classification":"GENERAL","confidence":0.9}', 'ค่ะ'],
    });

    const response = await say(harness, text);

    expect(harness.spies.embedQuery).toHaveBeenCalled();
    expect(response.assistantAct).not.toBe('ACKED');
    expect(response.text).not.toBe(templates.ack('ค่ะ'));
    expect(response.text).not.toBe(templates.thanks('ค่ะ'));
  });

  it('U6: "ค่ะ" right after a question from the bot answers that question', async () => {
    const harness = buildHarness({
      env: ON,
      generations: ['{"classification":"GENERAL","confidence":0.9}', 'ค่ะ'],
    });
    const asked = await say(harness, 'อันนี้ราคาเท่าไหร่');
    expect(asked.assistantAct).toBe('ASKED');

    clock += MINUTE;
    const answer = await say(harness, 'ค่ะ');

    expect(answer.assistantAct).not.toBe('ACKED');
    expect(harness.spies.embedQuery).toHaveBeenCalled();
  });

  it('an old question no longer holds the next "ค่ะ" hostage', async () => {
    const harness = buildHarness({ env: ON });
    await say(harness, 'อันนี้ราคาเท่าไหร่');

    clock += 31 * MINUTE;
    const response = await say(harness, 'ค่ะ');

    expect(response.text).toBe(templates.ack('ค่ะ'));
    noModelCalls(harness);
  });

  it('a registration form answer is never swallowed', async () => {
    const harness = buildHarness({ env: { ...ON, CAN_REGISTER: 'true' } });
    await harness.sessions.set('U1', {
      userId: 'U1',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: {},
    });

    const response = await say(harness, 'ครับ');

    expect(harness.spies.registrationHandle).toHaveBeenCalled();
    expect(response.source).toBe('REGISTRATION');
  });

  it('a greeting with a particle still reaches the greeting gate', async () => {
    const harness = buildHarness({ env: ON, generations: ['สวัสดีค่ะ'] });

    const response = await say(harness, 'สวัสดีครับ');

    expect(response.source).toBe('AI');
    expect(harness.systemInstruction()).toContain('small talk');
  });
});

describe('The flag off is the behaviour of today', () => {
  it('does not touch TurnMeta and attaches no act', async () => {
    const harness = buildHarness({ patterns: [timetable()] });

    const handoff = await say(harness, 'ขอคุยกับพนักงาน');
    const times = await say(harness, 'รอบรถ กรุงเทพ พัทยา');

    expect(handoff.assistantAct).toBeUndefined();
    expect(times.assistantAct).toBeUndefined();
    expect(harness.redis.hashes.size).toBe(0);
    expect(harness.redis.hgetall).not.toHaveBeenCalled();
  });

  it('routes "ครับ" through retrieval as it always did', async () => {
    const harness = buildHarness({
      generations: ['{"classification":"GENERAL","confidence":0.9}', 'ครับ'],
    });

    const response = await say(harness, 'ครับ');

    expect(harness.spies.embedQuery).toHaveBeenCalled();
    expect(response.text).not.toBe(templates.ack('ค่ะ'));
    expect(response.assistantAct).toBeUndefined();
  });

  it('rejects a flag value that is not a boolean', () => {
    expect(() =>
      buildHarness({ env: { PHATIC_FAST_PATH_ENABLED: 'yes' } }),
    ).toThrow('PHATIC_FAST_PATH_ENABLED must be true or false');
  });
});

describe('What the assistant did is recorded on every branch', () => {
  it('CLARIFY asks and remembers its own question', async () => {
    const harness = buildHarness({ env: ON });

    const response = await say(harness, 'อันนี้ราคาเท่าไหร่');

    expect(response.text).toBe(CLARIFY_MESSAGE);
    expect(response.assistantAct).toBe('ASKED');
    expect(response.askedText).toBe(CLARIFY_MESSAGE);
    expect(await harness.turnMeta.load('c1')).toMatchObject({
      lastAct: 'ASKED',
      askedText: CLARIFY_MESSAGE,
    });
  });

  it('a DIRECT FAQ answer is ANSWERED', async () => {
    const harness = buildHarness({ env: ON, patterns: [timetable()] });

    const response = await say(harness, 'รอบรถ กรุงเทพ พัทยา');

    expect(response.assistantAct).toBe('ANSWERED');
    expect(response.askedText).toBeUndefined();
  });

  it('a rich menu reply and the default menu are GREETED', async () => {
    const harness = buildHarness({
      env: ON,
      menuReplies: [{ key: 'promo', label: 'โปรวันนี้', replyText: 'ลด 20%' }],
    });

    const menu = await say(harness, 'โปรวันนี้', {
      postbackData: 'menu=promo',
    });
    const empty = await say(harness, '   ');

    expect(menu.assistantAct).toBe('GREETED');
    expect(empty.assistantAct).toBe('GREETED');
  });

  it('a general answer is GENERAL', async () => {
    const harness = buildHarness({ env: ON, generations: ['สวัสดีค่ะ'] });

    const response = await say(harness, 'สวัสดีครับ');

    expect(response.assistantAct).toBe('GENERAL');
  });

  it('cancel is GENERAL', async () => {
    const harness = buildHarness({ env: { ...ON, CAN_REGISTER: 'true' } });
    await harness.sessions.set('U1', {
      userId: 'U1',
      flow: 'REGISTER',
      step: 'ASK_NAME',
      status: 'ACTIVE',
      data: {},
    });

    const response = await say(harness, 'ยกเลิก');

    expect(response.assistantAct).toBe('GENERAL');
  });

  it('registration carries no act', async () => {
    const harness = buildHarness({ env: { ...ON, CAN_REGISTER: 'true' } });

    const response = await say(harness, 'สมัคร');

    expect(response.source).toBe('REGISTRATION');
    expect(response.assistantAct).toBeUndefined();
  });

  it('a request for a person is HANDOFF_NOTICE', async () => {
    const harness = buildHarness({ env: ON });

    expect((await say(harness, 'ติดต่อแอดมิน')).assistantAct).toBe(
      'HANDOFF_NOTICE',
    );
  });

  it('a partial answer that hands off is HANDOFF_NOTICE', async () => {
    const harness = buildHarness({
      env: ON,
      patterns: [
        pattern({
          id: 'ship',
          keywords: ['จัดส่ง', 'ส่ง'],
          answer: 'จัดส่งภายใน 3 วัน',
          renderMode: 'REWRITE',
        }),
      ],
      generations: [
        '{"askedAbout":"จัดส่ง","directlyAnswered":true,"decision":"ANSWER","answer":"จัดส่งภายใน 3 วัน","evidenceIds":["ANSWER_PATTERN:ship"],"unanswered":["เก็บเงินปลายทางได้ไหม"]}',
      ],
    });

    const response = await say(harness, 'ส่งกี่วัน และเก็บเงินปลายทางได้ไหม');

    expect(response.text).toContain(PARTIAL_ANSWER_NOTE);
    expect(response.assistantAct).toBe('HANDOFF_NOTICE');
  });

  it('a fallback that requests an admin is HANDOFF_NOTICE', async () => {
    const harness = buildHarness({
      env: ON,
      budgetAllows: false,
      aiSetting: { fallbackMessage: 'ขออภัยครับ' },
    });

    const response = await say(harness, 'ค่าส่งเท่าไหร่');

    expect(response.text).toBe('ขออภัยครับ');
    expect(response.assistantAct).toBe('HANDOFF_NOTICE');
  });

  it('a fallback with no room to hand off to is only FALLBACK', async () => {
    const harness = buildHarness({
      env: ON,
      budgetAllows: false,
      aiSetting: { fallbackMessage: 'ขออภัยครับ' },
    });
    harness.spies.conversationUpdateMany.mockResolvedValueOnce({ count: 0 });

    const response = await say(harness, 'ค่าส่งเท่าไหร่');

    expect(response.text).toBe('ขออภัยครับ');
    expect(response.assistantAct).toBe('FALLBACK');
  });

  it('a fallback that is not sent because the room is already waiting leaves no act', async () => {
    const harness = buildHarness({
      env: ON,
      budgetAllows: false,
      aiSetting: { fallbackMessage: 'ขออภัยครับ' },
    });
    harness.spies.conversationUpdateMany.mockResolvedValueOnce({ count: 0 });
    harness.spies.conversationCount.mockResolvedValueOnce(1);

    const response = await say(harness, 'ค่าส่งเท่าไหร่');

    expect(response.text).toBe('');
    expect(response.assistantAct).toBeUndefined();
    expect(harness.redis.hashes.size).toBe(0);
  });

  describe('a product answer', () => {
    const answered = (
      status: 'FOUND' | 'MISSING_INPUT',
      overrides: Record<string, unknown> = {},
    ) => {
      const harness = buildHarness({ env: ON });
      const retrieval = {
        route: 'RAG',
        selectedItems: [],
        product: {
          failed: false,
          plan: { mode: 'PRODUCT' },
          result: { status },
          ...overrides,
        },
      };
      jest.spyOn(harness.router, 'resolve').mockResolvedValue({
        action: 'ANSWER_KNOWLEDGE',
        intent: 'UNKNOWN',
        confidence: 1,
        source: 'DATABASE',
        reason: 'test',
        retrieval,
      } as unknown as RouteDecision);
      jest.spyOn(harness.aiChat, 'answerKnowledge').mockResolvedValue({
        text: 'ต้องการไซส์อะไรคะ',
        isFallback: false,
      } satisfies AiAnswerResult);
      return harness;
    };

    it('that asks the customer for more input is ASKED, with its own question', async () => {
      const harness = answered('MISSING_INPUT');

      const response = await say(harness, 'เสื้อตัวนี้มีไหม');

      expect(response.assistantAct).toBe('ASKED');
      expect(response.askedText).toBe('ต้องการไซส์อะไรคะ');
    });

    it('that states what was found is ANSWERED', async () => {
      const harness = answered('FOUND');

      const response = await say(harness, 'เสื้อตัวนี้มีไหม');

      expect(response.assistantAct).toBe('ANSWERED');
      expect(response.askedText).toBeUndefined();
    });
  });
});

describe('The meta kept for a room', () => {
  it('survives a Redis failure by behaving as if nothing were known', async () => {
    const harness = buildHarness({ env: ON, patterns: [timetable()] });
    harness.redis.hgetall.mockRejectedValueOnce(new Error('redis down'));

    const response = await say(harness, 'ครับ');

    // Unknown history is the "long idle" row: a short acknowledgement.
    expect(response.text).toBe(templates.ack('ค่ะ'));
  });

  it('is cleared with the room on resume-bot', async () => {
    const harness = buildHarness({ env: ON });
    await say(harness, 'ขอคุยกับพนักงาน');
    expect(await harness.turnMeta.load('c1')).toMatchObject({
      lastAct: 'HANDOFF_NOTICE',
    });

    await harness.turnMeta.clear('c1');

    expect(await harness.turnMeta.load('c1')).toEqual({});
  });
});
