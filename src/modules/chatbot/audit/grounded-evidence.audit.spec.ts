import { buildHarness, pattern } from './core-chat.harness';

// Synthetic hotel query B1, captured in the 2026-09-27 real-provider audit.
// Keep the provider payload verbatim: do not construct citations from the prompt.
const recordedReply =
  '{"decision":"ANSWER","answer":"เช็คอินได้ตั้งแต่ 14:00 น. เป็นต้นไปครับ หากคุณลูกค้ามีกำหนดการเข้าพักหลัง 22:00 น. รบกวนแจ้งทางโรงแรมล่วงหน้าด้วยนะครับ","evidenceIds":["2d43cd45-4493-505d-a476-6436c889df8f"]}';
const evidenceId = '2d43cd45-4493-505d-a476-6436c889df8f';
const request = {
  userId: 'U-evidence-test',
  text: 'เช็คอินได้ตั้งแต่กี่โมงครับ',
};
const checkIn = pattern({
  id: evidenceId,
  title: 'เวลาเช็คอิน',
  keywords: ['เช็คอิน'],
  answer:
    'เช็คอินได้ตั้งแต่ 14:00 น. ครับ หากมาหลัง 22:00 น. กรุณาแจ้งโรงแรมล่วงหน้าครับ',
});

function harnessWithRawReply(raw: string, ambiguous = false) {
  const harness = buildHarness({
    patterns: [checkIn],
    micro: ambiguous ? [checkIn] : [],
  });
  // Bypass the legacy harness adapter that fabricates valid evidenceIds.
  harness.spies.generate.mockImplementationOnce(() =>
    Promise.resolve({ text: raw }),
  );
  return harness;
}

describe('Grounded evidence contract with raw provider output', () => {
  it('answers the recorded Thai query without an unnecessary handoff or context clear', async () => {
    const harness = harnessWithRawReply(recordedReply);
    const response = await harness.chatbot.handleTextMessage(request);

    expect(response).toEqual({
      text: 'เช็คอินได้ตั้งแต่ 14:00 น. เป็นต้นไปครับ หากคุณลูกค้ามีกำหนดการเข้าพักหลัง 22:00 น. รบกวนแจ้งทางโรงแรมล่วงหน้าด้วยนะครับ',
      source: 'KNOWLEDGE',
      contextPolicy: 'INCLUDE',
    });
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it('supplies an explicit namespaced ref for the model to copy', async () => {
    const harness = harnessWithRawReply(recordedReply);
    await harness.chatbot.handleTextMessage(request);

    expect(harness.ragContext()).toEqual([
      expect.objectContaining({
        ref: `ANSWER_PATTERN:${evidenceId}`,
        source: 'ANSWER_PATTERN',
        id: evidenceId,
      }),
    ]);
    expect(harness.systemInstruction()).toContain('คัดลอกค่า ref');
  });

  it.each([
    ['namespaced', [`ANSWER_PATTERN:${evidenceId}`]],
    ['bare', [evidenceId]],
    ['mixed', [evidenceId, `ANSWER_PATTERN:${evidenceId}`]],
  ])(
    'accepts %s references to selected evidence',
    async (_label, evidenceIds) => {
      const harness = harnessWithRawReply(
        JSON.stringify({
          decision: 'ANSWER',
          answer: 'เช็คอิน 14:00 น.',
          evidenceIds,
        }),
      );
      const response = await harness.chatbot.handleTextMessage(request);
      expect(response.source).toBe('KNOWLEDGE');
      expect(response.contextPolicy).toBe('INCLUDE');
      expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unknown bare ID', ['not-selected']],
    ['unknown namespaced ID', ['ANSWER_PATTERN:not-selected']],
    ['wrong source', [`MICRO_KNOWLEDGE:${evidenceId}`]],
    ['one valid and one invalid ID', [evidenceId, 'not-selected']],
    ['no evidence', []],
  ])('rejects %s and requests an admin', async (_label, evidenceIds) => {
    const harness = harnessWithRawReply(
      JSON.stringify({
        decision: 'ANSWER',
        answer: 'เช็คอิน 14:00 น.',
        evidenceIds,
      }),
    );
    const response = await harness.chatbot.handleTextMessage(request);
    expect(response.source).toBe('SYSTEM');
    expect(response.contextPolicy).toBe('CLEAR');
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledTimes(1);
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
  });

  it('rejects a bare ID shared by two selected sources', async () => {
    const harness = harnessWithRawReply(recordedReply, true);
    const response = await harness.chatbot.handleTextMessage(request);
    expect(harness.ragContext()).toHaveLength(2);
    expect(response.source).toBe('SYSTEM');
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('accepts explicit source references even when bare IDs collide', async () => {
    const harness = harnessWithRawReply(
      JSON.stringify({
        decision: 'ANSWER',
        answer: 'เช็คอิน 14:00 น.',
        evidenceIds: [
          `ANSWER_PATTERN:${evidenceId}`,
          `MICRO_KNOWLEDGE:${evidenceId}`,
        ],
      }),
      true,
    );
    const response = await harness.chatbot.handleTextMessage(request);
    expect(harness.ragContext()).toHaveLength(2);
    expect(response.source).toBe('KNOWLEDGE');
    expect(harness.spies.conversationUpdateMany).not.toHaveBeenCalled();
  });
});
