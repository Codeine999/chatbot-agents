/**
 * Audit: how lexical (AnswerPattern), lexical (MicroKnowledge) and vector
 * candidates are scored, fused and chosen as the evidence handed to the LLM.
 *
 * Characterization tests. Names beginning with "observes" record behaviour
 * the audit reports as a defect; they are not an endorsement of it.
 */
import { buildHarness, pattern, vector } from './core-chat.harness';

const ask = (text: string) => ({
  userId: 'U1',
  text,
  conversationId: 'c1',
  turnId: 't1',
});

describe('Stage 1-2: keyword/DIRECT never involves MicroKnowledge or the LLM', () => {
  it('an exact question example answers verbatim from cache: no DB, no embedding, no micro, no model call', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-direct',
          questionExamples: ['ส่งฟรีไหม'],
          answer: 'ส่งฟรีเมื่อซื้อครบ 500 บาทครับ',
        }),
      ],
      micro: [
        pattern({ id: 'm-1', keywords: ['ส่งฟรี'], answer: 'ค่าส่ง 40 บาท' }),
      ],
    });

    const response = await harness.chatbot.handleTextMessage(ask('ส่งฟรีไหม'));

    expect(response.text).toBe('ส่งฟรีเมื่อซื้อครบ 500 บาทครับ');
    expect(harness.spies.generate).not.toHaveBeenCalled();
    expect(harness.spies.embedQuery).not.toHaveBeenCalled();
    expect(harness.spies.microFindMany).not.toHaveBeenCalled();
    expect(harness.spies.answerPatternFindMany).not.toHaveBeenCalled();
  });

  it('a keyword-only hit is NOT a DIRECT answer: it falls through to the fused stage', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-kw',
          keywords: ['ค่าส่ง'],
          answer: 'ค่าส่ง 40 บาทครับ',
        }),
      ],
      generations: ['ค่าส่ง 40 บาทครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('ค่าส่งเท่าไหร่'));

    expect(harness.spies.embedQuery).toHaveBeenCalledTimes(1);
    expect(harness.spies.microFindMany).toHaveBeenCalledTimes(1);
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
  });
});

describe('Stage 3: MicroKnowledge keyword matching and fusion', () => {
  it('MicroKnowledge is keyword-scored with the same matcher as AnswerPattern and reaches the LLM without any vector hit', async () => {
    const harness = buildHarness({
      patterns: [],
      micro: [
        pattern({
          id: 'm-ship',
          title: 'ค่าจัดส่ง',
          keywords: ['ค่าส่ง'],
          answer: 'ค่าจัดส่ง 40 บาททั่วประเทศ',
        }),
      ],
      generations: ['ค่าจัดส่ง 40 บาทครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('ค่าส่งเท่าไหร่'));

    expect(harness.ragContext()).toEqual([
      expect.objectContaining({ source: 'MICRO_KNOWLEDGE', id: 'm-ship' }),
    ]);
  });

  it('AnswerPattern and MicroKnowledge are handed to the LLM together in one grounded call', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-ship',
          keywords: ['ค่าส่ง'],
          answer: 'ค่าส่งเริ่มต้น 40 บาท',
        }),
      ],
      micro: [
        pattern({
          id: 'm-free',
          keywords: ['ค่าส่ง'],
          answer: 'ซื้อครบ 500 ส่งฟรี',
        }),
      ],
      generations: ['ค่าส่ง 40 บาท ซื้อครบ 500 ส่งฟรีครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('ค่าส่งเท่าไหร่'));

    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
    expect(
      harness
        .ragContext()
        .map((item) => `${item.source}:${item.id}`)
        .sort(),
    ).toEqual(['ANSWER_PATTERN:p-ship', 'MICRO_KNOWLEDGE:m-free']);
  });

  it('observes RRF rank fusion: a weak candidate on both lists outranks a much stronger keyword-only match', async () => {
    const harness = buildHarness({
      patterns: [
        // Strong lexical: full-message keyword (5) + multi-keyword bonus.
        pattern({
          id: 'p-strong',
          keywords: ['คืนสินค้ากี่วัน', 'คืนสินค้า', 'กี่วัน'],
          answer: 'คืนได้ภายใน 7 วันครับ',
        }),
        pattern({
          id: 'p-both',
          keywords: ['คืนสินค้า'],
          answer: 'นโยบายการคืนสินค้า',
        }),
      ],
      patternVectors: [
        vector({ id: 'p-both', score: 0.61, answer: 'นโยบายการคืนสินค้า' }),
      ],
      generations: ['คืนได้ภายใน 7 วันครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('คืนสินค้ากี่วัน'));

    const ranked = harness.ragContext().map((item) => item.id);
    expect(ranked[0]).toBe('p-both');
    expect(ranked).toContain('p-strong');
  });

  it('observes the evidence budget silently skipping the top-ranked item when it is oversized', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-huge',
          keywords: ['เงื่อนไข'],
          answer: 'ก'.repeat(12_001),
        }),
        pattern({
          id: 'p-small',
          keywords: ['เงื่อนไข'],
          answer: 'เงื่อนไขย่อ',
        }),
      ],
      generations: ['เงื่อนไขย่อครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('เงื่อนไขเป็นยังไง'));

    expect(harness.ragContext().map((item) => item.id)).toEqual(['p-small']);
  });

  it('observes only three contexts reaching the LLM, so curated patterns can be crowded out by micro facts', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-curated',
          keywords: ['โปรโมชั่น'],
          answer: 'โปรโมชั่นเดือนนี้',
        }),
      ],
      micro: [
        pattern({
          id: 'm-1',
          keywords: ['โปรโมชั่น', 'มีอะไรบ้าง'],
          answer: 'ลด 10%',
        }),
        pattern({
          id: 'm-2',
          keywords: ['โปรโมชั่น', 'มีอะไร'],
          answer: 'ส่งฟรี',
        }),
        pattern({
          id: 'm-3',
          keywords: ['โปรโมชั่น', 'อะไรบ้าง'],
          answer: 'ของแถม',
        }),
      ],
      generations: ['โปรเดือนนี้ครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('โปรโมชั่นมีอะไรบ้าง'));

    const ids = harness.ragContext().map((item) => item.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('p-curated');
  });
});

describe('Relevance gating', () => {
  it('observes weak vector neighbours turning small talk into a grounded RAG call and an admin handoff', async () => {
    const harness = buildHarness({
      patterns: [],
      micro: [],
      // Every row is above the 0.6 candidate floor but unrelated to the query.
      patternVectors: Array.from({ length: 5 }, (_, index) =>
        vector({
          id: `v-${index}`,
          title: 'นโยบายการคืนสินค้า',
          answer: 'คืนได้ภายใน 7 วัน',
          score: 0.62 - index * 0.001,
        }),
      ),
      generations: ['INSUFFICIENT_CONTEXT'],
    });

    const response = await harness.chatbot.handleTextMessage(
      ask('วันนี้อากาศดีจังเลยนะ'),
    );

    // No GENERAL/BUSINESS classification ever ran: RAG claimed the turn.
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
    expect(harness.ragContext()).not.toHaveLength(0);
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalled();
    expect(response.source).toBe('SYSTEM');
  });

  it('observes Thai substring keyword matching producing a false positive', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-pillow',
          title: 'หมอน',
          keywords: ['หมอน'],
          answer: 'หมอนรุ่นนี้ราคา 590 บาท',
        }),
      ],
      generations: ['ควรปรึกษาแพทย์ครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('นอนไม่หลับควรไปหาหมอนะ'));

    expect(harness.ragContext().map((item) => item.id)).toContain('p-pillow');
  });

  it('observes a conflict between two low-ranked candidates escalating the whole turn to an admin', async () => {
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-good',
          title: 'ค่าจัดส่ง',
          keywords: ['ค่าส่ง'],
          answer: 'ค่าส่ง 40 บาท',
        }),
        pattern({
          id: 'p-x',
          title: 'เวลาทำการ',
          keywords: ['ค่าส่ง'],
          answer: 'เปิดทำการ 9 โมง',
        }),
        pattern({
          id: 'p-y',
          title: 'เวลาทำการ',
          keywords: ['ค่าส่ง'],
          answer: 'เปิดทำการ 10 โมง',
        }),
      ],
      aiSetting: { fallbackMessage: 'ขออภัยครับ เดี๋ยวแอดมินมาดูแลนะครับ' },
    });

    const response = await harness.chatbot.handleTextMessage(
      ask('ค่าส่งเท่าไหร่'),
    );

    expect(harness.spies.generate).not.toHaveBeenCalled();
    expect(harness.spies.conversationUpdateMany).toHaveBeenCalled();
    expect(response.text).toBe('ขออภัยครับ เดี๋ยวแอดมินมาดูแลนะครับ');
  });
});

describe('DIRECT safety caps', () => {
  it('observes the verbatim DIRECT path switching itself off once the scan cap is reached', async () => {
    const filler = Array.from({ length: 499 }, (_, index) =>
      pattern({
        id: `filler-${index}`,
        keywords: [`คีย์${index}`],
        answer: `ตอบ ${index}`,
      }),
    );
    const harness = buildHarness({
      patterns: [
        pattern({
          id: 'p-direct',
          questionExamples: ['ส่งฟรีไหม'],
          answer: 'ส่งฟรีเมื่อซื้อครบ 500 บาทครับ',
        }),
        ...filler,
      ],
      cached: null,
      generations: ['ส่งฟรีเมื่อซื้อครบ 500 บาทครับ'],
    });

    await harness.chatbot.handleTextMessage(ask('ส่งฟรีไหม'));

    // 500 scanned rows disable safeDirect, so a curated preset now costs an
    // embedding and a generation call instead of being sent verbatim.
    expect(harness.spies.embedQuery).toHaveBeenCalledTimes(1);
    expect(harness.spies.generate).toHaveBeenCalledTimes(1);
  });
});
