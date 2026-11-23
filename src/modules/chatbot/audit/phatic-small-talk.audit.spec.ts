/**
 * Audit: a bare acknowledgement ("ครับ", "👍", "??") never searches or calls
 * the classifier. Code answers it alone where code is surer (an admin talking,
 * a room waiting for staff, a repeat); otherwise one general-chat call answers
 * it in context. A message that carries content is never mistaken for one. Replays the 2026-11-23 conversation from
 * docs/turn-understanding-plan.md §1.
 */
import { buildHarness, pattern, type Harness } from './core-chat.harness';
import { PARTIAL_ANSWER_NOTE } from '../../ai/prompt/ai-chat.constants';
import { CLARIFY_MESSAGE } from '../../../shared/knowledge/knowledge-routing.constants';
import { ReplyTemplateService } from '../../../shared/templates/answer-template.service';
import type {
  AiAnswerResult,
  ChatContextMessage,
  ChatResponse,
  RouteDecision,
} from '../../../shared/contracts/chat.types';
import type { DecisionTraceService } from '../../decision-log/decision-trace.service';

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

/** Exactly one general-chat call, and no embedding (so no search, no classifier). */
const oneGeneralCall = (harness: Harness, embeddingsBefore = 0) => {
  expect(harness.spies.generate).toHaveBeenCalledTimes(1);
  expect(harness.systemInstruction()).toContain('small talk');
  expect(harness.spies.embedQuery.mock.calls).toHaveLength(embeddingsBefore);
};

/** The three-turn context a room has after the bot answered something. */
const history = (
  assistant = 'รอบรถไปพัทยามีรอบ 08:00 และ 18:00 ค่ะ ต้องการดูรอบขากลับด้วยไหมคะ',
): { recentMessages: ChatContextMessage[] } => ({
  recentMessages: [
    { role: 'user', text: 'รอบรถ กรุงเทพ พัทยา', source: 'USER', createdAt: 1 },
    { role: 'assistant', text: assistant, source: 'KNOWLEDGE', createdAt: 2 },
  ],
});

/** Messages of the nth (default: last) provider call, as one string. */
const sentMessages = (harness: Harness, index = -1): string =>
  JSON.stringify(
    (
      harness.spies.generate.mock.calls.at(index) as unknown as [
        { messages: unknown },
      ]
    )?.[0]?.messages,
  );

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
    const harness = buildHarness({ env: ON, generations: ['ค่ะ'] });
    await say(harness, 'ขอคุยกับพนักงาน');

    clock += 25 * HOUR;
    const nudge = await say(harness, 'ครับ', { handoffPending: true });

    // General chat answers instead of the waiting notice.
    expect(nudge.text).toBe('ค่ะ');
    expect(nudge.text).not.toBe(templates.handoffWaiting('ค่ะ'));
    oneGeneralCall(harness);
  });
});

describe('A photo sent to staff counts as a handoff notice', () => {
  const slip = (harness: Harness) =>
    harness.chatbot.handleImageMessage({ userId: 'U1', conversationId: 'c1' });

  it('records the notice, so a nudge right after is not answered', async () => {
    const harness = buildHarness({ env: ON });

    const sent = await slip(harness);
    expect(sent.text).toBe('');
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'waiting_admin' } }),
    );
    expect(await harness.turnMeta.load('c1')).toEqual({
      handoffNoticeAt: clock,
    });

    clock += MINUTE;
    const nudge = await say(harness, 'ยังอยู่ไหม?', { handoffPending: true });

    expect(nudge.text).toBe('');
    noModelCalls(harness);
  });

  it('says staff were told once the cooldown has passed', async () => {
    const harness = buildHarness({ env: ON });
    await slip(harness);

    clock += 16 * MINUTE;
    const nudge = await say(harness, 'ครับ', { handoffPending: true });

    expect(nudge.text).toBe(templates.handoffWaiting('ค่ะ'));
    expect(nudge.assistantAct).toBe('HANDOFF_NOTICE');
    noModelCalls(harness);
  });

  it('records nothing when there is no room to hand off to', async () => {
    const harness = buildHarness({ env: ON });
    harness.spies.conversationUpdateMany.mockResolvedValueOnce({ count: 0 });

    await slip(harness);

    expect(await harness.turnMeta.load('c1')).toEqual({});
  });

  it('with the fast path off, a photo writes no TurnMeta', async () => {
    const harness = buildHarness();

    await slip(harness);

    expect(harness.redis.hashes.size).toBe(0);
  });
});

describe('Use cases', () => {
  it('U1: "โอเคครับ" after an answer that ended in a question gets one general call that reads it', async () => {
    const answer = jest.fn();
    const note = jest.fn();
    const trace = {
      answer,
      note,
      route: jest.fn(),
      enter: jest.fn(),
      handoff: jest.fn(),
      current: jest.fn(),
    } as unknown as DecisionTraceService;
    const harness = buildHarness({
      env: ON,
      patterns: [timetable()],
      generations: ['ได้เลยค่ะ รอบขากลับจากพัทยามี 10:00 และ 20:00 ค่ะ'],
      decisionTrace: trace,
    });
    await harness.turnMeta.markAssistant('c1', 'ANSWERED');

    clock += MINUTE;
    const response = await say(harness, 'โอเคครับ', history());

    expect(response).toEqual({
      text: 'ได้เลยค่ะ รอบขากลับจากพัทยามี 10:00 และ 20:00 ค่ะ',
      source: 'AI',
      contextPolicy: 'EXCLUDE',
      assistantAct: 'ACKED',
    });
    oneGeneralCall(harness);
    // The general call sees the question the bot asked at the end of its answer.
    expect(sentMessages(harness)).toContain('ต้องการดูรอบขากลับด้วยไหมคะ');
    expect(sentMessages(harness)).toContain('โอเคครับ');
    expect(answer).toHaveBeenLastCalledWith({ mode: 'PHATIC_GENERAL' });
    expect(note).toHaveBeenCalledWith('answer', {
      phatic: true,
      skipped: ['retrieval', 'classifier'],
    });
  });

  it('U1: a second "ครับ" right after is left alone, and answered again after the window', async () => {
    const harness = buildHarness({
      env: ON,
      generations: ['ยินดีค่ะ', 'ค่ะ มีอะไรให้ช่วยเพิ่มเติมไหมคะ'],
    });

    const first = await say(harness, 'โอเคครับ', history());
    expect(first.assistantAct).toBe('ACKED');

    clock += MINUTE;
    const second = await say(harness, 'ครับ', history());
    expect(second.text).toBe('');
    expect(second.contextPolicy).toBe('EXCLUDE');
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);

    // TurnMeta lives a day: an old acknowledgement must not mute the room.
    clock += 31 * MINUTE;
    const later = await say(harness, 'ครับ', history());
    expect(later.text).toBe('ค่ะ มีอะไรให้ช่วยเพิ่มเติมไหมคะ');
    expect(harness.spies.generate).toHaveBeenCalledTimes(2);
    expect(harness.spies.embedQuery).not.toHaveBeenCalled();
  });

  it('U2: thanks and a goodbye after a step-by-step answer: one call, then silence', async () => {
    const harness = buildHarness({
      env: ON,
      generations: ['ค่ะ หากโอนเรียบร้อยแล้วส่งสลิปมาในแชทนี้ได้เลยนะคะ'],
    });
    const steps = history('โอนมัดจำแล้วส่งสลิปในแชทนี้ได้เลยค่ะ');

    const thanks = await say(harness, 'ขอบคุณค่ะ', steps);
    expect(thanks.text).toBe(
      'ค่ะ หากโอนเรียบร้อยแล้วส่งสลิปมาในแชทนี้ได้เลยนะคะ',
    );
    expect(sentMessages(harness)).toContain('ส่งสลิป');

    clock += MINUTE;
    expect((await say(harness, 'แค่นี้ก่อนนะคะ', steps)).text).toBe('');
    oneGeneralCall(harness);
  });

  it.each(['ครับ', 'ฮัลโหล', '??', 'ยังอยู่ไหม?'])(
    'U4: "%s" as the first message of a new room opens the conversation (GREETED)',
    async (text) => {
      const harness = buildHarness({
        env: ON,
        generations: ['สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ'],
      });

      const response = await say(harness, text);

      expect(response).toEqual({
        text: 'สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ',
        source: 'AI',
        contextPolicy: 'INCLUDE',
        assistantAct: 'GREETED',
      });
      oneGeneralCall(harness);
    },
  );

  it.each(['ครัค่ะ', 'ค่ร่ะ', 'คับบบ', 'kub', '555'])(
    'U17: the slang "%s" skips search and the classifier',
    async (text) => {
      const harness = buildHarness({ env: ON, generations: ['ค่ะ'] });

      const response = await say(harness, text, history());

      expect(response.source).toBe('AI');
      expect(response.contextPolicy).toBe('EXCLUDE');
      oneGeneralCall(harness);
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

  it('keeps the reply out of the chat context while a topic is open', async () => {
    const harness = buildHarness({ env: ON, generations: ['ยินดีค่ะ'] });

    const response = await say(harness, 'ขอบคุณค่ะ', history());

    expect(response.contextPolicy).toBe('EXCLUDE');
    expect(response.source).toBe('AI');
  });

  it('a general call that fails falls back like any general answer', async () => {
    const harness = buildHarness({
      env: ON,
      budgetAllows: false,
      aiSetting: { fallbackMessage: 'ขออภัยค่ะ' },
    });

    const response = await say(harness, 'ครับ', history());

    expect(response.text).toBe('ขออภัยค่ะ');
    expect(response.assistantAct).toBe('HANDOFF_NOTICE');
    expect(harness.spies.embedQuery).not.toHaveBeenCalled();
  });

  it('tells the general call to keep the persona particle the tenant locked', async () => {
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

    harness.spies.generate.mockResolvedValueOnce({ text: 'ครับผม' });

    await say(harness, 'ครับ', history());

    expect(harness.systemInstruction()).toContain(
      'ใช้คำลงท้าย "ครับ" ทุกข้อความ',
    );
    expect(harness.systemInstruction()).toContain('ห้ามขึ้นต้นด้วยคำทักทาย');
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
    const harness = buildHarness({ env: ON, generations: ['ค่ะ'] });
    await say(harness, 'อันนี้ราคาเท่าไหร่');
    const embeddingsBefore = harness.spies.embedQuery.mock.calls.length;

    clock += 31 * MINUTE;
    const response = await say(harness, 'ค่ะ', history(CLARIFY_MESSAGE));

    expect(response.text).toBe('ค่ะ');
    oneGeneralCall(harness, embeddingsBefore);
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
    const harness = buildHarness({
      env: ON,
      patterns: [timetable()],
      generations: ['ค่ะ'],
    });
    harness.redis.hgetall.mockRejectedValueOnce(new Error('redis down'));

    const response = await say(harness, 'ครับ', history());

    // Unknown state is "nothing for code to decide": general chat answers.
    expect(response.text).toBe('ค่ะ');
    oneGeneralCall(harness);
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
