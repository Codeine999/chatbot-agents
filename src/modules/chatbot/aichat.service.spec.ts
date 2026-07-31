import { PrismaService } from '../../prisma/prisma.service';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { AiChatService } from './aichat.service';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { DEFAULT_FALLBACK_MESSAGE } from './constants/ai-chat.constants';
import { KnowledgeItem } from './types/chat.types';

const FALLBACK = 'ขออภัย เดี๋ยวแอดมินติดต่อกลับนะครับ';

const keywordItem = (score: number, over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  source: 'ANSWER_PATTERN',
  id: 'p1',
  title: 'ราคาค่าบริการ',
  content: 'รายละเอียด',
  answer: 'เริ่มต้น 1,000 บาท',
  score,
  ...over,
});

const semanticItem = (score: number, over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  source: 'SEMANTIC_CHUNK',
  id: 's1',
  title: 'ราคาค่าบริการ',
  content: 'รายละเอียด',
  answer: 'เริ่มต้น 1,000 บาท',
  score,
  ...over,
});

function build() {
  const prisma = {
    aiSetting: {
      findFirst: jest.fn().mockResolvedValue({
        systemPrompt: 'คุณคือแอดมิน',
        tone: 'สุภาพ',
        fallbackMessage: FALLBACK,
      }),
    },
  };
  const answerPatternService = {
    findMatches: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AnswerPatternService>;
  const semanticSearchService = {
    search: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SemanticSearchService>;
  const aiBudgetService = {
    tryConsume: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<AiBudgetService>;
  const usersAiProviderService = {
    generate: jest.fn().mockResolvedValue({ text: 'คำตอบจากโมเดล' }),
  } as unknown as jest.Mocked<UsersAiProviderService>;

  const service = new AiChatService(
    prisma as unknown as PrismaService,
    answerPatternService,
    semanticSearchService,
    aiBudgetService,
    usersAiProviderService,
  );

  const systemInstruction = () =>
    usersAiProviderService.generate.mock.calls[0][0].systemInstruction as string;

  return {
    service,
    prisma,
    answerPatternService,
    semanticSearchService,
    aiBudgetService,
    usersAiProviderService,
    systemInstruction,
  };
}

describe('AiChatService.answerKnowledge', () => {
  it('prefers decision.retrievalQuery over the raw message for retrieval', async () => {
    const { service, answerPatternService } = build();

    await service.answerKnowledge('แล้วราคาล่ะ', {
      retrievalQuery: 'ราคาค่าบริการเท่าไหร่',
    });

    expect(answerPatternService.findMatches).toHaveBeenCalledWith(
      'ราคาค่าบริการเท่าไหร่',
    );
  });

  it('falls back to the raw message when retrievalQuery is blank', async () => {
    const { service, answerPatternService } = build();

    await service.answerKnowledge('ราคาเท่าไหร่', { retrievalQuery: '   ' });

    expect(answerPatternService.findMatches).toHaveBeenCalledWith('ราคาเท่าไหร่');
  });

  describe('direct answer gate', () => {
    it('returns the stored answer verbatim on a strong, unambiguous match', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(5.5)]);

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result).toEqual({ text: 'เริ่มต้น 1,000 บาท', isFallback: false });
      expect(ctx.usersAiProviderService.generate).not.toHaveBeenCalled();
    });

    it('requires a 2-point gap over the runner-up', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([
        keywordItem(5.5),
        keywordItem(4.0, { id: 'p2' }),
      ]);

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result.text).toBe('คำตอบจากโมเดล');
      expect(ctx.usersAiProviderService.generate).toHaveBeenCalled();
    });

    it('does not fire below the score threshold of 5', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(4.9)]);

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result.text).toBe('คำตอบจากโมเดล');
    });

    it('never fires for a semantic item, however high its score', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([]);
      ctx.semanticSearchService.search.mockResolvedValue([semanticItem(0.99)]);

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result.text).toBe('คำตอบจากโมเดล');
    });
  });

  describe('grounding', () => {
    it('embeds every retrieved item into the system instruction', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([
        keywordItem(3, { title: 'หัวข้อ A', answer: 'ตอบ A' }),
        keywordItem(2.5, { id: 'p2', title: 'หัวข้อ B', answer: 'ตอบ B' }),
      ]);

      await ctx.service.answerKnowledge('ราคา');
      const instruction = ctx.systemInstruction();

      expect(instruction).toContain('[ข้อมูลที่ 1]');
      expect(instruction).toContain('หัวข้อ A');
      expect(instruction).toContain('[ข้อมูลที่ 2]');
      expect(instruction).toContain('ตอบ B');
      expect(instruction).toContain('ตอบโดยใช้ข้อมูลนี้เท่านั้น');
    });

    it('instructs the model to emit the exact fallback when context is thin', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(3)]);

      await ctx.service.answerKnowledge('ราคา');

      expect(ctx.systemInstruction()).toContain(FALLBACK);
    });

    it('carries a prompt-injection warning about history and user text', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(3)]);

      await ctx.service.answerKnowledge('ราคา');

      expect(ctx.systemInstruction()).toContain('ไม่น่าเชื่อถือ');
    });
  });

  describe('embedding fallback path', () => {
    it('only runs when the keyword search returned nothing', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([]);
      ctx.semanticSearchService.search.mockResolvedValue([semanticItem(0.8)]);

      await ctx.service.answerKnowledge('ราคา', { userId: 'U1' });

      expect(ctx.semanticSearchService.search).toHaveBeenCalledWith('ราคา', 'U1');
    });

    it('returns the fallback verbatim when semantic search is also empty', async () => {
      const ctx = build();

      const result = await ctx.service.answerKnowledge('อะไรก็ไม่รู้');

      expect(result).toEqual({ text: FALLBACK, isFallback: true });
      expect(ctx.usersAiProviderService.generate).not.toHaveBeenCalled();
    });

    it('returns the fallback when semantic search throws', async () => {
      const ctx = build();
      ctx.semanticSearchService.search.mockRejectedValue(new Error('502'));

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result).toEqual({ text: FALLBACK, isFallback: true });
    });

    it('still reaches the embedding path when the keyword query itself throws', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockRejectedValue(new Error('db down'));
      ctx.semanticSearchService.search.mockResolvedValue([semanticItem(0.8)]);

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(ctx.semanticSearchService.search).toHaveBeenCalled();
      expect(result.isFallback).toBe(false);
    });

    /**
     * DEFECT: the keyword and embedding retrievers are mutually exclusive here,
     * not blended. A single weak keyword hit (score 2 clears MIN_MATCH_SCORE)
     * suppresses the embedding search entirely, so the semantically correct
     * pattern is never even considered. KnowledgeRetrievalService implements
     * the hybrid version of this, but AiChatService does not use it.
     */
    it('DEFECT: one weak keyword hit suppresses embedding retrieval completely', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([
        keywordItem(2.0, { title: 'หัวข้อที่ไม่เกี่ยว' }),
      ]);

      await ctx.service.answerKnowledge('ราคาเท่าไหร่');

      expect(ctx.semanticSearchService.search).not.toHaveBeenCalled();
      expect(ctx.systemInstruction()).toContain('หัวข้อที่ไม่เกี่ยว');
    });
  });

  describe('budget and provider failures', () => {
    it('returns the fallback without calling the provider when over budget', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(3)]);
      ctx.aiBudgetService.tryConsume.mockResolvedValue(false);

      const result = await ctx.service.answerKnowledge('ราคา', { userId: 'U1' });

      expect(result).toEqual({ text: FALLBACK, isFallback: true });
      expect(ctx.usersAiProviderService.generate).not.toHaveBeenCalled();
    });

    it('returns the fallback when the provider throws', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(3)]);
      ctx.usersAiProviderService.generate.mockRejectedValue(new Error('429'));

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result).toEqual({ text: FALLBACK, isFallback: true });
    });

    it('returns the fallback when the provider returns blank text', async () => {
      const ctx = build();
      ctx.answerPatternService.findMatches.mockResolvedValue([keywordItem(3)]);
      ctx.usersAiProviderService.generate.mockResolvedValue({
        text: '   ',
        provider: 'GEMINI',
        model: 'gemini-3.1-flash-lite',
      });

      const result = await ctx.service.answerKnowledge('ราคา');

      expect(result).toEqual({ text: FALLBACK, isFallback: true });
    });

    /**
     * DEFECT: one knowledge answer consumes the AI budget twice - once for the
     * query embedding and once for generation - on top of the intent
     * classifier's own charge. The per-user hourly limit is therefore reached
     * roughly 3x sooner than AI_USER_LIMIT_PER_HOUR suggests.
     */
    it('DEFECT: the embedding path bills the budget twice for one answer', async () => {
      const ctx = build();
      ctx.semanticSearchService.search.mockResolvedValue([semanticItem(0.8)]);

      await ctx.service.answerKnowledge('ราคา', { userId: 'U1' });

      // one charge here for generation; the embedding charge happens inside
      // EmbeddingService, which the semantic mock stands in for.
      expect(ctx.aiBudgetService.tryConsume).toHaveBeenCalledWith('U1');
      expect(ctx.semanticSearchService.search).toHaveBeenCalledWith('ราคา', 'U1');
    });
  });

  describe('AiSetting resolution', () => {
    it('uses built-in defaults when no active setting exists', async () => {
      const ctx = build();
      ctx.prisma.aiSetting.findFirst.mockResolvedValue(null);

      const result = await ctx.service.answerKnowledge('อะไรก็ไม่รู้');

      expect(result.text).toBe(DEFAULT_FALLBACK_MESSAGE);
    });

    it('uses built-in defaults when the settings query throws', async () => {
      const ctx = build();
      ctx.prisma.aiSetting.findFirst.mockRejectedValue(new Error('db down'));

      const result = await ctx.service.answerKnowledge('อะไรก็ไม่รู้');

      expect(result.text).toBe(DEFAULT_FALLBACK_MESSAGE);
    });
  });
});

describe('AiChatService.answerGeneral', () => {
  it('never touches the knowledge base', async () => {
    const ctx = build();

    await ctx.service.answerGeneral('สวัสดีครับ', { userId: 'U1' });

    expect(ctx.answerPatternService.findMatches).not.toHaveBeenCalled();
    expect(ctx.semanticSearchService.search).not.toHaveBeenCalled();
  });

  it('forbids inventing shop-specific facts', async () => {
    const ctx = build();

    await ctx.service.answerGeneral('สวัสดีครับ');

    expect(ctx.systemInstruction()).toContain('ห้ามแต่งข้อมูลเฉพาะของร้าน');
  });

  it('appends the current input after the recent history', async () => {
    const ctx = build();

    await ctx.service.answerGeneral('ล่าสุด', {
      recentMessages: [
        { role: 'user', text: 'ก่อนหน้า', source: 'USER', createdAt: 1 },
      ],
    });

    const messages = ctx.usersAiProviderService.generate.mock.calls[0][0].messages;
    expect(messages.map((m) => m.text)).toEqual(['ก่อนหน้า', 'ล่าสุด']);
  });
});

describe('AiChatService.answerFallback', () => {
  it('returns the configured fallback and never calls a provider', async () => {
    const ctx = build();

    const result = await ctx.service.answerFallback();

    expect(result).toEqual({ text: FALLBACK, isFallback: true });
    expect(ctx.usersAiProviderService.generate).not.toHaveBeenCalled();
    expect(ctx.aiBudgetService.tryConsume).not.toHaveBeenCalled();
  });
});
