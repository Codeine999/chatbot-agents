/**
 * Review evidence, not acceptance criteria. Tests named "observes" record
 * current limitations/defects. No real database, Redis, LINE or AI connection.
 * The existing harness mocks caches, vector repositories, budget, embedding
 * service and generation boundary. The budget case below explicitly replaces
 * its embedding stub with the REAL EmbeddingService.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AnswerPattern } from '../../../generated/prisma/client';
import { EmbeddingService } from '../../ai/embeding/embedding.service';
import { PendingAiUsageError } from '../../usage/billing/pending-ai-usage.error';
import { CreateAdminAnswerPatternDto } from '../../admin/knowledge/dto/admin-answer-pattern.dto';
import { AnswerPatternCacheService } from '../knowledge/answer-pattern-cache.service';
import { resolveRetrievalQuery } from '../knowledge/retrieval-query-planner.service';
import { LoadContextService } from '../context/load-context.service';
import { buildHarness, fakeRedis, pattern, vector } from './core-chat.harness';

const ask = (text: string) => ({ userId: 'U-review', text, turnId: 'review' });

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('Current RAG review: routing and retrieval', () => {
  it('asks for the missing reference before reading knowledge or generating', async () => {
    const query = 'อันนี้คืนได้ไหม';
    expect(resolveRetrievalQuery(query, []).missingReference).toBe(true);
    const h = buildHarness({
      patterns: [pattern({ questionExamples: [query], answer: 'คืนได้ครับ' })],
    });
    const response = await h.chatbot.handleTextMessage(ask(query));
    expect(response.text).toBe('ช่วยอธิบายเพิ่มเติมหน่อยได้มั้ยครับ');
    expect(response.source).toBe('RULE');
    expect(h.spies.answerPatternFindMany).not.toHaveBeenCalled();
    expect(h.spies.embedQuery).not.toHaveBeenCalled();
    expect(h.spies.generate).not.toHaveBeenCalled();
  });

  it('observes REAL embedding budget rejection discarding usable lexical evidence and handing off', async () => {
    const h = buildHarness({
      patterns: [pattern({ keywords: ['ค่าส่ง'], answer: 'จัดส่งทั่วประเทศ' })],
    });
    const adapterCall = jest.fn(() => {
      throw new Error('unexpected external embedding');
    });
    const billingCall = jest.fn(() => {
      throw new Error('unexpected billing');
    });
    const budgetCall = jest.fn(() => Promise.resolve(false));
    const embedding = new EmbeddingService(
      { embed: adapterCall } as never,
      { tryConsume: budgetCall } as never,
      { runBilledEmbedding: billingCall } as never,
    );
    h.spies.embedQuery.mockImplementation(async () => {
      const result = await embedding.embedQuery('ค่าส่งเท่าไหร่', {
        userId: 'U-review',
      });
      return { ...result, values: [...result.values] };
    });
    const retrieval = await h.retrieval.retrieve('ค่าส่งเท่าไหร่');
    expect(retrieval.items).toHaveLength(1);
    expect(retrieval.selectedItems).toHaveLength(0);
    expect(retrieval.fallbackReason).toBe('RETRIEVAL_ERROR');
    await h.chatbot.handleTextMessage(ask('ค่าส่งเท่าไหร่'));
    expect(budgetCall).toHaveBeenCalled();
    expect(adapterCall).not.toHaveBeenCalled();
    expect(billingCall).not.toHaveBeenCalled();
    expect(h.spies.tryConsume).not.toHaveBeenCalled();
    expect(h.spies.generate).not.toHaveBeenCalled();
    expect(h.spies.notifyAdminRequired).toHaveBeenCalledTimes(1);
  });

  it('preserves uncertain billing errors instead of turning them into a final fallback', async () => {
    const h = buildHarness();
    h.spies.embedQuery.mockRejectedValueOnce(new PendingAiUsageError());
    await expect(
      h.chatbot.handleTextMessage(ask('สอบถามการจัดส่ง')),
    ).rejects.toBeInstanceOf(PendingAiUsageError);
    expect(h.spies.notifyAdminRequired).not.toHaveBeenCalled();
  });

  it('observes cache conflicts short-circuiting the authoritative DB and all other sources', async () => {
    const h = buildHarness({
      cached: [
        pattern({
          id: 'old-a',
          title: 'เวลาจัดส่ง',
          keywords: ['จัดส่ง'],
          answer: 'จัดส่งภายใน 3 วัน',
        }),
        pattern({
          id: 'old-b',
          title: 'เวลาจัดส่ง',
          keywords: ['จัดส่ง'],
          answer: 'จัดส่งภายใน 7 วัน',
        }),
      ],
      patterns: [
        pattern({
          questionExamples: ['จัดส่งกี่วัน'],
          answer: 'จัดส่งภายใน 3 วัน',
        }),
      ],
    });
    const result = await h.retrieval.retrieve('จัดส่งกี่วัน');
    expect(result.fallbackReason).toBe('CONFLICTING_CANDIDATES');
    expect(h.spies.answerPatternFindMany).not.toHaveBeenCalled();
    expect(h.spies.embedQuery).not.toHaveBeenCalled();
  });

  it('observes a second refresh joining an older read and retaining the pre-write snapshot', async () => {
    let finishRead!: (rows: AnswerPattern[]) => void;
    const read = jest.fn(
      () =>
        new Promise<AnswerPattern[]>((resolve) => {
          finishRead = resolve;
        }),
    );
    const cache = new AnswerPatternCacheService(
      { answerPattern: { findMany: read } } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
    );
    const beforeWrite = cache.refresh();
    // Simulate an admin commit between the SELECT snapshot and its completion.
    const afterWrite = cache.refresh();
    expect(afterWrite).toBe(beforeWrite);
    finishRead([pattern({ answer: 'ข้อความก่อนแก้ไข' }) as AnswerPattern]);
    await afterWrite;
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.getAll()[0].answer).toBe('ข้อความก่อนแก้ไข');
  });

  it('observes an approved DIRECT answer never consulting a contradictory micro fact', async () => {
    const h = buildHarness({
      patterns: [
        pattern({
          questionExamples: ['ซักเครื่องได้ไหม'],
          answer: 'ซักเครื่องได้',
        }),
      ],
      micro: [
        pattern({
          id: 'exception',
          keywords: ['ซักเครื่อง'],
          answer: 'ไม่สามารถซักเครื่องได้',
        }),
      ],
    });
    expect(
      (await h.chatbot.handleTextMessage(ask('ซักเครื่องได้ไหม'))).text,
    ).toBe('ซักเครื่องได้');
    expect(h.spies.microFindMany).not.toHaveBeenCalled();
  });

  it('keeps identical ids from different sources distinct and supplies both to one grounded call', async () => {
    const h = buildHarness({
      patterns: [
        pattern({
          id: 'same-id',
          keywords: ['จัดส่ง'],
          answer: 'จัดส่งวันจันทร์ถึงศุกร์',
        }),
      ],
      micro: [
        pattern({
          id: 'same-id',
          keywords: ['จัดส่ง'],
          answer: 'ใช้บริการขนส่งเอกชน',
        }),
      ],
      generations: ['จัดส่งวันจันทร์ถึงศุกร์ผ่านขนส่งเอกชน'],
    });
    await h.chatbot.handleTextMessage(ask('จัดส่งอย่างไร'));
    expect(h.ragContext().map((item) => `${item.source}:${item.id}`)).toEqual([
      'ANSWER_PATTERN:same-id',
      'MICRO_KNOWLEDGE:same-id',
    ]);
    expect(h.spies.embedQuery).toHaveBeenCalledTimes(1);
    expect(h.spies.generate).toHaveBeenCalledTimes(1);
    expect(h.spies.cacheGetAll).toHaveBeenCalledTimes(1);
  });

  it('observes identical answers consuming all evidence slots and dropping a complementary fact', async () => {
    const h = buildHarness({
      patterns: [
        pattern({
          id: 'p',
          keywords: ['จัดส่ง'],
          priority: 100,
          answer: 'จัดส่งทั่วประเทศ',
        }),
      ],
      micro: [
        pattern({
          id: 'm1',
          keywords: ['จัดส่ง'],
          priority: 99,
          answer: 'จัดส่งทั่วประเทศ',
        }),
        pattern({
          id: 'm2',
          keywords: ['จัดส่ง'],
          priority: 98,
          answer: 'จัดส่งทั่วประเทศ',
        }),
        pattern({
          id: 'needed',
          keywords: ['จัดส่ง'],
          answer: 'พื้นที่ห่างไกลใช้เวลาเพิ่มอีกสองวัน',
        }),
      ],
    });
    const result = await h.retrieval.retrieve('จัดส่งอย่างไร');
    expect(result.items).toHaveLength(4);
    expect(result.selectedItems.map((item) => item.answer)).toEqual(
      Array(3).fill('จัดส่งทั่วประเทศ'),
    );
    expect(result.selectedItems.some((item) => item.id === 'needed')).toBe(
      false,
    );
  });

  it('observes answer-only information receiving no lexical match', async () => {
    const h = buildHarness({
      micro: [
        pattern({ title: 'บริการ', answer: 'สามารถเปลี่ยนวันนัดหมายได้' }),
      ],
    });
    const result = await h.retrieval.retrieve('เปลี่ยนวันนัดหมาย');
    expect(result.items).toHaveLength(0);
    expect(result.route).toBe('LOW_CONFIDENCE');
  });

  it('observes an exact approved question beyond the 500-row scan not being found lexically', async () => {
    const h = buildHarness({
      cached: [],
      patterns: [
        ...Array.from({ length: 500 }, (_, i) => pattern({ id: `row-${i}` })),
        pattern({
          id: 'needed',
          questionExamples: ['เปลี่ยนวันนัดหมายได้ไหม'],
        }),
      ],
    });
    const result = await h.retrieval.retrieve('เปลี่ยนวันนัดหมายได้ไหม');
    expect(result.items).toHaveLength(0);
    expect(result.route).toBe('LOW_CONFIDENCE');
  });

  it('observes an exact REWRITE example losing priority to a higher-scoring non-exact match', async () => {
    const h = buildHarness({
      patterns: [
        pattern({
          id: 'exact',
          renderMode: 'REWRITE',
          questionExamples: ['คืนสินค้ากี่วัน'],
        }),
        pattern({
          id: 'non-exact',
          keywords: ['คืนสินค้ากี่วัน', 'คืนสินค้า', 'กี่วัน'],
        }),
      ],
    });
    const result = await h.retrieval.retrieve('คืนสินค้ากี่วัน');
    expect(result.items[0].id).toBe('non-exact');
    expect(result.items[1].metadata?.exactMatch).toBe(true);
  });

  it('observes the same row from vector search replacing lexical content during fusion', async () => {
    const h = buildHarness({
      patterns: [
        pattern({
          id: 'same',
          keywords: ['จัดส่ง'],
          answer: 'ข้อความจาก lexical snapshot',
        }),
      ],
      patternVectors: [
        vector({ id: 'same', answer: 'ข้อความจาก vector snapshot' }),
      ],
    });
    const result = await h.retrieval.retrieve('จัดส่งอย่างไร');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].answer).toBe('ข้อความจาก vector snapshot');
    expect(result.items[0].metadata).toMatchObject({
      rawScore: 3,
      vectorSimilarity: 0.8,
    });
  });
});

describe('Current RAG review: surrounding safety and contracts', () => {
  it('observes registration PII in a how-to digression reaching embedding and generation inputs', async () => {
    const h = buildHarness({
      env: { CAN_REGISTER: 'true' },
      patterns: [pattern({ keywords: ['สมัคร'], answer: 'กรอกแบบฟอร์มสมัคร' })],
      generations: ['กรอกแบบฟอร์มสมัครครับ'],
    });
    await h.sessions.set('U-review', {
      userId: 'U-review',
      flow: 'REGISTER',
      step: 'ASK_PHONE',
      status: 'ACTIVE',
      data: {},
    });
    const text = 'สมัครยังไง เบอร์โทร: 0812345678'; // Synthetic fixture only.
    await h.chatbot.handleTextMessage(ask(text));
    expect(h.spies.registrationHandle).not.toHaveBeenCalled();
    expect(h.spies.embedQuery).toHaveBeenCalledWith(text, expect.anything());
    expect(h.systemInstruction()).toContain('0812345678');
    expect(h.spies.generate).toHaveBeenCalledTimes(1);
  });

  it('observes waiting_admin not muting the next automatic AI turn', async () => {
    const h = buildHarness({ generations: ['สวัสดีครับ'] });
    await h.chatbot.handleTextMessage(ask('ติดต่อแอดมิน'));
    expect(h.spies.conversationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'waiting_admin' } }),
    );
    expect(await h.sessions.isMuted('U-review')).toBe(false);
    const response = await h.chatbot.handleTextMessage(ask('สวัสดีครับ'));
    expect(response.source).toBe('AI');
    expect(h.spies.generate).toHaveBeenCalledTimes(1);
  });

  it('observes email addresses remaining in stored context after redaction', async () => {
    const redis = fakeRedis();
    const context = new LoadContextService(redis as never);
    await context.appendTurn({
      conversationId: 'review',
      eventId: 'review',
      userText: 'ติดต่อ audit@example.invalid',
      response: { text: 'รับทราบครับ', source: 'AI', contextPolicy: 'INCLUDE' },
    });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(redis.eval.mock.calls)).toContain(
      'audit@example.invalid',
    );
  });

  it('observes greeting text on a sticker suppressing its accompanying business question', async () => {
    const h = buildHarness();
    const response = await h.chatbot.handleStickerMessage({
      userId: 'U-review',
      packageId: '1',
      stickerId: '1',
      text: 'สวัสดีครับ จัดส่งวันไหน',
    });
    expect(response.text).toBe('สวัสดีครับ สอบถามเรื่องไหนครับ');
    expect(h.spies.cacheGetAll).not.toHaveBeenCalled();
  });

  it('observes the admin create schema stripping the requested REWRITE render mode', () => {
    const parsed = CreateAdminAnswerPatternDto.schema.parse({
      title: 'จัดส่ง',
      answer: 'รายละเอียด',
      renderMode: 'REWRITE',
    });
    expect(parsed).not.toHaveProperty('renderMode');
  });
});
