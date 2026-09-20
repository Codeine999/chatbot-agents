import { PendingAiUsageError } from '../usage/billing/pending-ai-usage.error';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AnswerPattern,
  MicroKnowledge,
} from '../../generated/prisma/client';
import { UsersAiProviderService } from '../ai/users-ai-provider.service';
import { AiProviderSettingsService } from '../ai/ai-provider-settings.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { AiBillingService } from '../usage/billing/ai-billing.service';
import { AiBudgetService } from '../usage/rate-limit/ai-budget.service';
import { EmbeddingService } from '../ai/embeding/embedding.service';
import {
  AnswerPatternVectorRepository,
  SemanticSearchRow,
} from '../ai/embeding/answer-pattern-vector.repository';
import {
  MicroKnowledgeVectorRepository,
  MicroKnowledgeSearchRow,
} from '../ai/embeding/micro-knowledge-vector.repository';
import { AnswerPatternService } from './knowledge/answer-pattern.service';
import { AnswerPatternCacheService } from './knowledge/answer-pattern-cache.service';
import { MicroKnowledgeService } from './knowledge/micro-knowledge.service';
import { SemanticSearchService } from './knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from './knowledge/knowledge-retrieval.service';
import { AiIntentClassifierService } from './ai-intent-classifier.service';
import { IntentRouterService } from './intent-router.service';
import { RuleIntentService } from './rule-intent.service';
import { RichMenuReplyCacheService } from './menu/rich-menu-reply-cache.service';
import { ChatbotService } from './chatbot.service';
import { AiChatService } from './aichat.service';
import { UserSessionService } from './user-session.service';
import { RegistrationFlowService } from '../registration/registration-flow.service';
import { ReplyTemplateService } from './reply-template.service';
import { StickerIntentService } from './sticker-intent.service';
import type { AiGenerateResponse } from '../../ai-provider/types/ai-provider.types';
import type {
  ChatContextMessage,
  KnowledgeRetrievalResult,
} from './types/chat.types';
import type { ConversationSession } from './types/session.types';
import {
  MAX_RAG_CONTEXTS,
  MAX_RETRIEVAL_CANDIDATES,
  MAX_RAG_EVIDENCE_CHARACTERS,
  RRF_RANK_CONSTANT,
} from './constants/knowledge-routing.constants';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const question = 'วิธีดูแลหมอนรุ่น Cloud';
const paraphrase = 'หมอน Cloud เอาลงเครื่องซักทั้งใบเลยได้ปะ';
const fallback = 'ยังไม่มีข้อมูลยืนยันครับ ส่งต่อแอดมินช่วยตรวจสอบ';
const response = (text: string): AiGenerateResponse => ({
  text,
  provider: 'GEMINI',
  model: 'test',
  usage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
  },
});
const pattern = (overrides: Partial<AnswerPattern> = {}): AnswerPattern => ({
  id: ID,
  tenantId: null,
  title: 'การดูแลหมอน Cloud',
  description: null,
  category: 'care',
  intentKey: 'care',
  keywords: ['หมอน Cloud'],
  questionExamples: [question],
  answer: 'ถอดปลอกซักได้ แต่ห้ามซักไส้หมอน',
  language: 'th',
  renderMode: 'DIRECT',
  priority: 0,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});
const fact = (overrides: Partial<MicroKnowledge> = {}): MicroKnowledge => {
  const base = pattern();
  return { ...base, entityKey: 'cloud', topicKey: 'cover-care', ...overrides };
};
const vectorRow = (
  overrides: Partial<SemanticSearchRow> = {},
): SemanticSearchRow => ({
  id: ID,
  title: 'การดูแลหมอน Cloud',
  description: null,
  category: 'care',
  intentKey: 'care',
  answer: 'ถอดปลอกซักได้ แต่ห้ามซักไส้หมอน',
  priority: 0,
  score: 0.82,
  renderMode: 'direct',
  tenantId: null,
  language: 'th',
  questionExamples: [],
  ...overrides,
});
const microRow = (
  overrides: Partial<MicroKnowledgeSearchRow> = {},
): MicroKnowledgeSearchRow => {
  const base = vectorRow();
  return { ...base, entityKey: 'cloud', topicKey: 'care', ...overrides };
};
const history = (...texts: string[]): ChatContextMessage[] =>
  texts.map((text, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    source: i % 2 ? 'AI' : 'USER',
    text,
    createdAt: i,
  }));

function build(
  options: {
    cached?: AnswerPattern[];
    patterns?: AnswerPattern[];
    micro?: MicroKnowledge[];
    vectors?: SemanticSearchRow[];
    microVectors?: MicroKnowledgeSearchRow[];
    config?: Record<string, unknown>;
  } = {},
) {
  const config = new ConfigService({
    CAN_REGISTER: 'true',
    ...(options.config ?? {}),
  });
  const prisma = {
    answerPattern: {
      findMany: jest.fn().mockResolvedValue(options.patterns ?? []),
    },
    microKnowledge: {
      findMany: jest.fn().mockResolvedValue(options.micro ?? []),
    },
    aiSetting: {
      findFirst: jest.fn().mockResolvedValue({
        systemPrompt: 'ตอบอย่างเป็นธรรมชาติ',
        ownerPrompt: 'คุณเป็นแอดมินของร้านหมอน',
        tone: 'สุภาพ อบอุ่น',
        skills: [
          {
            name: 'customer-sales',
            prompt: 'ตอบคำถามก่อนแล้วแนะนำอย่างเป็นธรรมชาติ',
          },
        ],
        responseStyle: { targetLength: 'short', emojiLevel: 'light' },
        promptVersion: 2,
        fallbackMessage: fallback,
      }),
    },
    $queryRaw: jest
      .fn()
      .mockImplementation((sql: { strings: string[] }) =>
        Promise.resolve(
          sql.strings.join('').includes('"microKnowledgeVector"')
            ? (options.microVectors ?? [])
            : (options.vectors ?? []),
        ),
      ),
  };
  const db = prisma as unknown as PrismaService;
  const provider = new UsersAiProviderService(
    {} as AiProviderSettingsService,
    {} as AiProviderService,
    {} as AiBillingService,
  );
  const generate = jest
    .spyOn(provider, 'generate')
    .mockRejectedValue(new Error('Unexpected generation call'));
  const budget = { tryConsume: jest.fn().mockResolvedValue(true) };
  const embedding = {
    values: [0.1, 0.2, 0.3],
    model: 'test-embedding',
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
    usageEstimated: false,
  };
  const embed = {
    embedQuery: jest
      .fn<Promise<typeof embedding>, [string, unknown?]>()
      .mockResolvedValue(embedding),
  };
  const vectors = new AnswerPatternVectorRepository(db);
  const microVectors = new MicroKnowledgeVectorRepository(db);
  const patternSearch = jest.spyOn(vectors, 'search');
  const microSearch = jest.spyOn(microVectors, 'search');
  const matcher = new AnswerPatternService(db, config);
  const cache = new AnswerPatternCacheService(db, config);
  const cacheRead = jest
    .spyOn(cache, 'getAll')
    .mockReturnValue(options.cached ?? []);
  const semantic = new SemanticSearchService(
    embed as unknown as EmbeddingService,
    vectors,
    microVectors,
    config,
  );
  const retrieval = new KnowledgeRetrievalService(
    matcher,
    cache,
    semantic,
    new MicroKnowledgeService(db, matcher, config),
    config,
  );
  const retrieve = jest.spyOn(retrieval, 'retrieve');
  const aiChat = new AiChatService(
    db,
    retrieval,
    budget as unknown as AiBudgetService,
    provider,
    config,
  );
  const classifier = new AiIntentClassifierService(
    budget as unknown as AiBudgetService,
    provider,
  );
  const classify = jest.spyOn(classifier, 'classifyLowConfidence');
  // This harness covers text routing only; no menu is configured, so every
  // lookup misses and routing falls through exactly as it does today.
  const richMenuReplies = {
    byKey: () => null,
    byLabel: () => null,
    labels: () => [],
  } as unknown as RichMenuReplyCacheService;
  const router = new IntentRouterService(
    new RuleIntentService(),
    retrieval,
    classifier,
    richMenuReplies,
  );
  const session = {
    get: jest
      .fn<Promise<ConversationSession | undefined>, []>()
      .mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
    isMuted: jest.fn().mockResolvedValue(false),
    requestAdmin: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  const registration = {
    start: jest.fn().mockResolvedValue('กรอกข้อมูลสมัคร'),
    handle: jest.fn().mockResolvedValue('กรอกข้อมูลต่อ'),
  };
  const service = new ChatbotService(
    router,
    session as unknown as UserSessionService,
    registration as unknown as RegistrationFlowService,
    new ReplyTemplateService(),
    aiChat,
    new StickerIntentService(),
    richMenuReplies,
    config,
  );
  const send = (text: string, recentMessages: ChatContextMessage[] = []) =>
    service.handleTextMessage({
      userId: 'test-user',
      lineMemberId: ID,
      conversationId: ID,
      turnId: 'test-turn',
      text,
      recentMessages,
    });
  return {
    service,
    send,
    generate,
    budget,
    embed,
    embedding,
    patternSearch,
    microSearch,
    prisma,
    retrieve,
    retrieval,
    cacheRead,
    classify,
    session,
    registration,
  };
}

describe('core text reply flow (real router/retrieval/classifier/answer, mocked external boundaries)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network forbidden in core tests'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['ยกเลิก', 'สมัคร', 'ติดต่อแอดมิน', '1', '2', '3'])(
    'strong rule %s uses zero generation/retrieval calls',
    async (text) => {
      const ctx = build();
      const result = await ctx.send(text);
      expect(result.text).toBeTruthy();
      expect(ctx.retrieve).not.toHaveBeenCalled();
      expect(ctx.generate).not.toHaveBeenCalled();
    },
  );

  it('cache exact approved question returns the stored answer without DB, embedding or generation', async () => {
    const ctx = build({ cached: [pattern()] });
    expect(await ctx.send(question)).toEqual({
      text: pattern().answer,
      source: 'KNOWLEDGE',
      contextPolicy: 'INCLUDE',
    });
    expect(ctx.prisma.answerPattern.findMany).not.toHaveBeenCalled();
    expect(ctx.prisma.microKnowledge.findMany).not.toHaveBeenCalled();
    expect(ctx.patternSearch).not.toHaveBeenCalled();
    expect(ctx.embed.embedQuery).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('insufficient cache continues to DB and an exact DB preset stops before embedding', async () => {
    const ctx = build({ patterns: [pattern()] });
    await ctx.send(question);
    expect(ctx.prisma.answerPattern.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, tenantId: null, language: 'th' },
      }),
    );
    expect(ctx.embed.embedQuery).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it.each(['cached', 'patterns'] as const)(
    'a safe REWRITE preset from %s continues retrieval and includes MicroKnowledge',
    async (layer) => {
      const rewrite = pattern({ renderMode: 'REWRITE' });
      const micro = fact({
        id: '00000000-0000-4000-8000-000000000003',
        answer: 'ห้ามซักไส้หมอนด้วยน้ำ',
      });
      const ctx = build({
        cached: layer === 'cached' ? [rewrite] : [],
        patterns: [rewrite],
        micro: [micro],
      });
      ctx.generate.mockResolvedValueOnce(
        response('ถอดปลอกซักได้ครับ ส่วนไส้เก็บแยกไว้'),
      );
      await ctx.send(question);
      expect(ctx.generate).toHaveBeenCalledTimes(1);
      expect(ctx.embed.embedQuery).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.microKnowledge.findMany).toHaveBeenCalledTimes(1);
      expect(ctx.generate.mock.calls[0][0].systemInstruction).toContain(
        'MICRO_KNOWLEDGE',
      );
      expect(ctx.classify).not.toHaveBeenCalled();
    },
  );

  it('broad keyword ราคา never takes the direct path, even as a question example', async () => {
    const ctx = build({
      cached: [pattern({ keywords: ['ราคา'], questionExamples: ['ราคา'] })],
      patterns: [pattern({ keywords: ['ราคา'], questionExamples: ['ราคา'] })],
    });
    ctx.generate.mockResolvedValueOnce(response('INSUFFICIENT_CONTEXT'));
    await ctx.send('ราคา');
    expect(ctx.prisma.answerPattern.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.embed.embedQuery).toHaveBeenCalledTimes(1);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.session.requestAdmin).toHaveBeenCalledWith('test-user');
  });

  it('a .99 AnswerPattern semantic hit is RAG with one call, never cosine DIRECT', async () => {
    const ctx = build({ vectors: [vectorRow({ score: 0.99 })] });
    ctx.generate.mockResolvedValueOnce(response('ซักได้เฉพาะปลอกครับ'));
    expect((await ctx.send(paraphrase)).source).toBe('KNOWLEDGE');
    expect(
      (
        await (ctx.retrieve.mock.results[0]
          .value as Promise<KnowledgeRetrievalResult>)
      ).route,
    ).toBe('RAG');
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).not.toHaveBeenCalled();
  });

  it('MicroKnowledge alone is RAG with one call even at high similarity', async () => {
    const ctx = build({ microVectors: [microRow({ score: 0.99 })] });
    ctx.generate.mockResolvedValueOnce(response('ถอดปลอกออกก่อนซักครับ'));
    await ctx.send(paraphrase);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.generate.mock.calls[0][0].systemInstruction).toContain(
      'MICRO_KNOWLEDGE',
    );
    expect(ctx.classify).not.toHaveBeenCalled();
  });

  it('embeds once and passes the exact same vector/model to both real repositories with scope filters', async () => {
    const ctx = build({ config: { KNOWLEDGE_TENANT_ID: OTHER_TENANT } });
    ctx.generate.mockResolvedValueOnce(
      response('{"classification":"BUSINESS","confidence":0.9}'),
    );
    await ctx.send(paraphrase);
    expect(ctx.embed.embedQuery).toHaveBeenCalledTimes(1);
    for (const spy of [ctx.patternSearch, ctx.microSearch]) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(ctx.embedding.values);
      expect(spy.mock.calls[0]).toEqual([
        ctx.embedding.values,
        ctx.embedding.model,
        MAX_RETRIEVAL_CANDIDATES,
        { tenantId: OTHER_TENANT, language: 'th' },
      ]);
    }
    for (const [sql] of ctx.prisma.$queryRaw.mock.calls as Array<
      [{ strings: string[]; values: unknown[] }]
    >) {
      const text = sql.strings.join('');
      expect(text).toContain('IS NOT DISTINCT FROM');
      expect(text).toContain('"language"');
      expect(text).toContain('"active" = true');
      expect(text).toContain('"embeddingModel"');
      expect(text).toContain('<=>');
      expect(sql.values).toContain(OTHER_TENANT);
    }
  });

  it('mixed sources with colliding UUIDs stay distinct and ground a single answer', async () => {
    const ctx = build({
      vectors: [vectorRow({ answer: 'ซักปลอกได้' })],
      microVectors: [microRow({ answer: 'ห้ามซักไส้หมอน' })],
    });
    ctx.generate.mockResolvedValueOnce(
      response('ซักเฉพาะปลอกครับ ส่วนไส้ห้ามซักน้ำ'),
    );
    await ctx.send(paraphrase);
    const result = await (ctx.retrieve.mock.results[0]
      .value as Promise<KnowledgeRetrievalResult>);
    expect(result.selectedItems.map((item) => item.source)).toEqual([
      'ANSWER_PATTERN',
      'MICRO_KNOWLEDGE',
    ]);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    const prompt = ctx.generate.mock.calls[0][0].systemInstruction;
    expect(prompt).toContain('ซักปลอกได้');
    expect(prompt).toContain('ห้ามซักไส้หมอน');
  });

  it('RAG generation sends every AiSetting and data section deterministically', async () => {
    const ctx = build({ vectors: [vectorRow()] });
    ctx.generate.mockResolvedValueOnce(response('ถอดปลอกก่อนซักครับ'));

    await ctx.send(paraphrase, history('สนใจหมอน Cloud', 'ยินดีแนะนำครับ'));

    const prompt = ctx.generate.mock.calls[0][0].systemInstruction ?? '';
    for (const section of [
      'systemPrompt',
      'ownerPrompt',
      'tone',
      'skill',
      'responseStyle',
      'historyMessage',
      'currentMessage',
      'ragContext',
    ]) {
      expect(prompt).toContain(`<${section}>`);
      expect(prompt).toContain(`</${section}>`);
    }
    expect(prompt).toContain('customer-sales');
    expect(prompt).toContain('targetLength: short');
    expect(prompt).toContain('สนใจหมอน Cloud');
    expect(prompt).toContain(paraphrase);
    expect(prompt).toContain('ถอดปลอกซักได้ แต่ห้ามซักไส้หมอน');
    expect(prompt).not.toContain('[object Object]');
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('\nnull\n');
  });

  it('GENERAL generation uses the same sections with an empty RAG context', async () => {
    const ctx = build();
    ctx.generate.mockResolvedValueOnce(response('สวัสดีครับ'));

    await ctx.send('สวัสดี', history('เมื่อวานคุยกัน', 'จำได้ครับ'));

    const prompt = ctx.generate.mock.calls[0][0].systemInstruction ?? '';
    expect(prompt).toContain('<systemPrompt>');
    expect(prompt).toContain('<ownerPrompt>');
    expect(prompt).toContain('<tone>');
    expect(prompt).toContain('<skill>');
    expect(prompt).toContain('<responseStyle>');
    expect(prompt).toContain('<historyMessage>');
    expect(prompt).toContain('<currentMessage>');
    expect(prompt).toContain('<ragContext>\n[]\n</ragContext>');
    expect(prompt).not.toContain('[object Object]');
  });

  it('image answer generation uses the structured AiSetting prompt', async () => {
    const ctx = build();
    ctx.generate.mockResolvedValueOnce(
      response('{"classification":"SAFE_GENERAL","answer":"เป็นรูปแมวครับ"}'),
    );

    await ctx.service.handleImageMessage({
      userId: 'test-user',
      lineMemberId: ID,
      conversationId: ID,
      turnId: 'image-turn',
      image: { mediaType: 'image/png', data: 'fixture' },
      recentMessages: history('ช่วยดูรูปนี้หน่อย', 'ส่งรูปมาได้เลยครับ'),
    });

    const request = ctx.generate.mock.calls[0][0];
    expect(request.systemInstruction).toContain('<systemPrompt>');
    expect(request.systemInstruction).toContain('<ownerPrompt>');
    expect(request.systemInstruction).toContain('<historyMessage>');
    expect(request.systemInstruction).toContain(
      '<ragContext>\n[]\n</ragContext>',
    );
    expect(request.messages.at(-1)?.images).toHaveLength(1);
  });

  it('lexical MicroKnowledge uses the same matcher but cannot be direct', async () => {
    const ctx = build({ micro: [fact({ answer: 'เฉพาะปลอกซักได้' })] });
    ctx.generate.mockResolvedValueOnce(response('ซักเฉพาะปลอกได้ครับ'));
    await ctx.send(question);
    expect(ctx.prisma.microKnowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, tenantId: null, language: 'th' },
      }),
    );
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(
      (
        await (ctx.retrieve.mock.results[0]
          .value as Promise<KnowledgeRetrievalResult>)
      ).route,
    ).toBe('RAG');
  });

  it('LOW -> BUSINESS calls only classification and performs static handoff', async () => {
    const ctx = build();
    ctx.generate.mockResolvedValueOnce(
      response(
        '{"classification":"BUSINESS","confidence":0.8,"reason":"store policy"}',
      ),
    );
    expect(await ctx.send('ร้านรับสลักชื่อไหม')).toEqual({
      text: fallback,
      source: 'SYSTEM',
      contextPolicy: 'CLEAR',
    });
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).toHaveBeenCalledTimes(1);
    expect(ctx.session.requestAdmin).toHaveBeenCalledWith('test-user');
    expect(ctx.generate.mock.calls[0][0].messages.at(-1)?.text).not.toContain(
      '"response"',
    );
  });

  it('LOW -> GENERAL is the only two-call route and uses answerGeneral profile', async () => {
    const ctx = build();
    ctx.generate
      .mockResolvedValueOnce(
        response('{"classification":"GENERAL","confidence":0.9}'),
      )
      .mockResolvedValueOnce(
        response('วันนี้เหนื่อยมากไหมครับ พักสักนิดได้นะ'),
      );
    const result = await ctx.send('วันนี้เหนื่อยมากจัง');
    expect(result.contextPolicy).toBe('INCLUDE');
    expect(ctx.generate).toHaveBeenCalledTimes(2);
    expect(ctx.classify).toHaveBeenCalledTimes(1);
    expect(ctx.generate.mock.calls[1][0].systemInstruction).toContain(
      'สุภาพ อบอุ่น',
    );
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it.each(['สวัสดี', 'ขอบคุณ', 'โอเค', 'hi', 'hello', 'thanks'])(
    'greeting %s goes directly to one general call',
    async (text) => {
      const ctx = build();
      ctx.generate.mockResolvedValueOnce(response('สวัสดีครับ'));
      await ctx.send(text);
      expect(ctx.generate).toHaveBeenCalledTimes(1);
      expect(ctx.retrieve).not.toHaveBeenCalled();
      expect(ctx.classify).not.toHaveBeenCalled();
    },
  );

  it('RAG insufficient never re-enters classifier or calls general afterward', async () => {
    const ctx = build({ vectors: [vectorRow()] });
    ctx.generate.mockResolvedValueOnce(
      response('```text\nINSUFFICIENT_CONTEXT\n```'),
    );
    expect((await ctx.send(paraphrase)).text).toBe(fallback);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('conflicting complete presets for the same question hand off without generation', async () => {
    const ctx = build({
      cached: [
        pattern({ answer: 'ปลอกซักได้' }),
        pattern({ id: 'other', answer: 'ปลอกซักไม่ได้' }),
      ],
    });
    await ctx.send(question);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('opposite assertions about the same entity hand off without an LLM choosing', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'ปลอกซักได้' }),
        microRow({ id: 'other', answer: 'ปลอกซักไม่ได้' }),
      ],
    });
    await ctx.send(paraphrase);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('complementary same-category facts do not conflict', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'ปลอกซักได้', topicKey: 'cover' }),
        microRow({ id: 'other', answer: 'ไส้ซักไม่ได้', topicKey: 'core' }),
      ],
    });
    ctx.generate.mockResolvedValueOnce(response('ซักได้เฉพาะปลอกครับ'));
    await ctx.send(paraphrase);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it('numeric disagreement on the same keyed fact is a conflict, not a model choice', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'รับประกัน 7 วัน' }),
        microRow({ id: 'other', answer: 'รับประกัน 14 วัน' }),
      ],
    });
    await ctx.send('หมอน Cloud รับประกันกี่วัน');
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('numeric disagreement between two approved presets cannot be chosen by priority', async () => {
    const ctx = build({
      cached: [
        pattern({ answer: 'รับประกัน 7 วัน' }),
        pattern({ id: 'other', answer: 'รับประกัน 14 วัน' }),
      ],
    });
    await ctx.send(question);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('explicit negation on a refund fact is detected without a business-specific LLM', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'สินค้าแกะกล่องคืนได้' }),
        microRow({ id: 'other', answer: 'สินค้าแกะกล่องคืนไม่ได้' }),
      ],
    });
    await ctx.send('แกะกล่องแล้วคืนได้ไหม');
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('different keyed topics can have opposite short answers without a conflict', async () => {
    const ctx = build({
      microVectors: [
        microRow({ topicKey: 'cover', title: 'ปลอกหมอน', answer: 'ซักได้' }),
        microRow({
          id: 'other',
          topicKey: 'core',
          title: 'ไส้หมอน',
          answer: 'ซักไม่ได้',
        }),
      ],
    });
    ctx.generate.mockResolvedValueOnce(response('ซักได้เฉพาะปลอกครับ'));
    await ctx.send(paraphrase);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.generate.mock.calls[0][0].systemInstruction).toContain(
      '"topicKey": "cover"',
    );
    expect(ctx.generate.mock.calls[0][0].systemInstruction).toContain(
      '"topicKey": "core"',
    );
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it('conditional numeric alternatives are not mistaken for an unconditional conflict', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'เมื่อใช้งาน 7 วัน ให้ตรวจปลอก' }),
        microRow({ id: 'other', answer: 'เมื่อใช้งาน 14 วัน ให้ตรวจปลอก' }),
      ],
    });
    ctx.generate.mockResolvedValueOnce(
      response('ตรวจปลอกหลังใช้งานตามช่วงเวลาที่ระบุครับ'),
    );
    await ctx.send('หมอนต้องดูแลยังไง');
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it('different entities with opposite care instructions are not a contradiction', async () => {
    const ctx = build({
      microVectors: [
        microRow({ entityKey: 'cloud', answer: 'ปลอกซักได้' }),
        microRow({ id: 'other', entityKey: 'air', answer: 'ปลอกซักไม่ได้' }),
      ],
    });
    ctx.generate.mockResolvedValueOnce(
      response('รุ่น Cloud ซักปลอกได้ แต่รุ่น Air ไม่ได้ครับ'),
    );
    await ctx.send('รุ่น Cloud กับ Air ซักเหมือนกันไหม');
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it('different exact answers beyond the top-20 cutoff disable DIRECT without claiming a contradiction', async () => {
    const cached = Array.from({ length: 21 }, (_, i) =>
      pattern({
        id: `p${i}`,
        answer: i === 20 ? 'มีข้อมูลเพิ่มเติมอีกส่วนหนึ่ง' : pattern().answer,
      }),
    );
    const ctx = build({ cached });
    ctx.generate.mockResolvedValueOnce(
      response('{"classification":"BUSINESS","confidence":1}'),
    );
    await ctx.send(question);
    expect(ctx.prisma.answerPattern.findMany).toHaveBeenCalledTimes(1);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
  });

  it('presets sharing a question may complement each other, so they use RAG instead of DIRECT or conflict', async () => {
    const records = [
      pattern({ answer: 'ปลอกซักได้' }),
      pattern({ id: 'other', answer: 'ไส้ซักไม่ได้' }),
    ];
    const ctx = build({ cached: records, patterns: records });
    ctx.generate.mockResolvedValueOnce(
      response('ซักเฉพาะปลอกได้ครับ ส่วนไส้ห้ามซัก'),
    );
    await ctx.send(question);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.session.set).not.toHaveBeenCalled();
    expect(ctx.generate.mock.calls[0][0].systemInstruction).toContain(
      'ไส้ซักไม่ได้',
    );
  });

  it('successful empty DB lookup does not resurrect a stale lexical cache result', async () => {
    const ctx = build({ cached: [pattern()] });
    const result = await ctx.retrieval.retrieve(paraphrase);
    expect(result.items).toHaveLength(0);
    expect(result.route).toBe('LOW_CONFIDENCE');
  });

  it('a configured vector noise floor filters cosine, never the RRF rank', async () => {
    const ctx = build({
      vectors: [vectorRow({ score: 0.7 })],
      config: { KNOWLEDGE_VECTOR_CANDIDATE_MIN_SIMILARITY: 0.75 },
    });
    const result = await ctx.retrieval.retrieve(paraphrase);
    expect(result.selectedItems).toHaveLength(0);
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('RRF merges lexical + vector for one source ID without treating the fused rank as probability', async () => {
    const ctx = build({ patterns: [pattern()], vectors: [vectorRow()] });
    const result = await ctx.retrieval.retrieve('ขอรายละเอียดหมอน Cloud หน่อย');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].score).toBeCloseTo(2 / (RRF_RANK_CONSTANT + 1));
    expect(result.items[0].metadata).toEqual(
      expect.objectContaining({
        rawScore: expect.any(Number) as unknown,
        vectorSimilarity: 0.82,
      }),
    );
    expect(result.route).toBe('RAG'); // RRF score is far below legacy .6.
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('candidate pool and selected context stay bounded', async () => {
    const ctx = build({
      vectors: Array.from({ length: 20 }, (_, i) => vectorRow({ id: `p${i}` })),
      microVectors: Array.from({ length: 20 }, (_, i) =>
        microRow({ id: `m${i}` }),
      ),
    });
    ctx.generate.mockResolvedValueOnce(response('ตอบจากข้อมูลที่ให้'));
    await ctx.send(paraphrase);
    const result = await (ctx.retrieve.mock.results[0]
      .value as Promise<KnowledgeRetrievalResult>);
    expect(result.items.length).toBeLessThanOrEqual(MAX_RETRIEVAL_CANDIDATES);
    expect(result.selectedItems.length).toBeLessThanOrEqual(MAX_RAG_CONTEXTS);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
  });

  it('does not truncate an oversized fact and accidentally drop its exception', async () => {
    const ctx = build({
      microVectors: [
        microRow({ answer: 'ก'.repeat(MAX_RAG_EVIDENCE_CHARACTERS + 1) }),
      ],
    });
    const result = await ctx.retrieval.retrieve(paraphrase);
    expect(result.selectedItems).toHaveLength(0);
    expect(result.route).toBe('LOW_CONFIDENCE');
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('wrong scope, language and inactive records cannot enter the reply', async () => {
    const ctx = build({
      cached: [
        pattern({ tenantId: OTHER_TENANT }),
        pattern({ active: false }),
        pattern({ language: 'en' }),
      ],
      patterns: [pattern({ tenantId: OTHER_TENANT })],
      micro: [fact({ tenantId: OTHER_TENANT })],
      vectors: [vectorRow({ tenantId: OTHER_TENANT })],
      microVectors: [microRow({ language: 'en' })],
    });
    const result = await ctx.retrieval.retrieve(question);
    expect(result.items).toHaveLength(0);
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('one unambiguous model reference uses one deterministic embedding query', async () => {
    const ctx = build({ microVectors: [microRow()] });
    ctx.generate.mockResolvedValueOnce(response('ซักเฉพาะปลอกครับ'));
    await ctx.send(
      'แล้วตัวนั้นซักได้ไหม',
      history('สนใจหมอน', 'แนะนำรุ่น Cloud ครับ'),
    );
    expect(ctx.embed.embedQuery).toHaveBeenCalledTimes(1);
    expect(ctx.embed.embedQuery.mock.calls[0][0]).toBe(
      'รุ่น cloud\nแล้วตัวนั้นซักได้ไหม',
    );
    expect(ctx.generate).toHaveBeenCalledTimes(1);
  });

  it('ambiguous model references ask a static clarification without ranking a winner', async () => {
    const ctx = build();
    const result = await ctx.send(
      'แล้วตัวนั้นซักได้ไหม',
      history('มีรุ่น Cloud กับรุ่น Air', 'ทั้งสองรุ่นต่างกันครับ'),
    );
    expect(result.text).toContain('รุ่นไหน');
    expect(ctx.embed.embedQuery).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it.each([
    'not json',
    '{"classification":"GENERAL","confidence":"yes"}',
    '{"classification":"GENERAL","confidence":1,"response":"untrusted answer"}',
  ])(
    'invalid classifier result fails safely without a second call: %s',
    async (text) => {
      const ctx = build();
      ctx.generate.mockResolvedValueOnce(response(text));
      await ctx.send('ถามเรื่องอื่น');
      expect(ctx.generate).toHaveBeenCalledTimes(1);
      expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
    },
  );

  it('RAG provider failure never triggers extra classification/generation', async () => {
    const ctx = build({ vectors: [vectorRow()] });
    ctx.generate.mockRejectedValueOnce(new Error('provider unavailable'));
    const result = await ctx.send(paraphrase);
    expect(result.contextPolicy).toBe('EXCLUDE');
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).not.toHaveBeenCalled();
  });

  it('partial vector failure fails closed instead of using incomplete evidence', async () => {
    const ctx = build({ patterns: [pattern()] });
    ctx.microSearch.mockRejectedValueOnce(new Error('index unavailable'));
    await ctx.send(paraphrase);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('pending settlement propagates without extra calls or a final handoff', async () => {
    const ctx = build({ vectors: [vectorRow()] });
    ctx.generate.mockRejectedValueOnce(new PendingAiUsageError());
    await expect(ctx.send(paraphrase)).rejects.toBeInstanceOf(
      PendingAiUsageError,
    );
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it('a same-subject contradiction across preset and micro sources is not sent to the model', async () => {
    const ctx = build({
      vectors: [vectorRow({ answer: 'ปลอกซักได้' })],
      microVectors: [microRow({ answer: 'ปลอกซักไม่ได้' })],
    });
    await ctx.send(paraphrase);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('budget denial avoids all generation', async () => {
    const ctx = build();
    ctx.budget.tryConsume.mockResolvedValue(false);
    await ctx.send('ไม่มีข้อมูล');
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.session.requestAdmin).toHaveBeenCalledTimes(1);
  });

  it('active registration continues without exposing its input to retrieval or models', async () => {
    const ctx = build();
    ctx.session.get.mockResolvedValue({
      userId: 'test-user',
      flow: 'REGISTER',
      step: 'WAITING_NAME',
      status: 'ACTIVE',
      data: {},
    });
    await ctx.send('ชื่อทดสอบ');
    expect(ctx.registration.handle).toHaveBeenCalledTimes(1);
    expect(ctx.retrieve).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it.each(['สมัคร', '1'])(
    'CAN_REGISTER=false rejects registration start %s without starting a session',
    async (text) => {
      const ctx = build({ config: { CAN_REGISTER: 'false' } });
      const result = await ctx.send(text);

      expect(result.text).toContain('ยังไม่มีระบบสมัครสมาชิก');
      expect(ctx.registration.start).not.toHaveBeenCalled();
      expect(ctx.session.set).not.toHaveBeenCalled();
      expect(ctx.retrieve).not.toHaveBeenCalled();
      expect(ctx.generate).not.toHaveBeenCalled();
    },
  );

  it('CAN_REGISTER=false clears an existing registration before routing its input', async () => {
    const ctx = build({ config: { CAN_REGISTER: 'false' } });
    ctx.session.get.mockResolvedValue({
      userId: 'test-user',
      flow: 'REGISTER',
      step: 'WAITING_NAME',
      status: 'ACTIVE',
      data: {},
    });

    const result = await ctx.send('ข้อมูลสมัครเดิม');

    expect(result.text).toContain('ยังไม่มีระบบสมัครสมาชิก');
    expect(ctx.session.clear).toHaveBeenCalledWith('test-user');
    expect(ctx.registration.handle).not.toHaveBeenCalled();
    expect(ctx.retrieve).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('the AI menu during registration preserves the registration session and uses zero calls', async () => {
    const ctx = build();
    ctx.session.get.mockResolvedValue({
      userId: 'test-user',
      flow: 'REGISTER',
      step: 'WAITING_NAME',
      status: 'ACTIVE',
      data: {},
    });
    expect((await ctx.send('2')).text).toContain('สอบถามเรื่องอะไร');
    expect(ctx.session.set).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('registration knowledge digression retrieves once and preserves session on success', async () => {
    const ctx = build({ vectors: [vectorRow()] });
    ctx.session.get.mockResolvedValue({
      userId: 'test-user',
      flow: 'REGISTER',
      step: 'WAITING_NAME',
      status: 'ACTIVE',
      data: {},
    });
    ctx.generate.mockResolvedValueOnce(response('ทำตามขั้นตอนสมัครครับ'));
    await ctx.send('สมัครยังไง');
    expect(ctx.retrieve).toHaveBeenCalledTimes(1);
    expect(ctx.generate).toHaveBeenCalledTimes(1);
    expect(ctx.session.set).not.toHaveBeenCalled();
  });

  it.each([undefined, 'REGISTER'] as const)(
    'mute blocks every text before RAG including cancel and invalid length (workflow=%s)',
    async (flow) => {
      const ctx = build();
      ctx.session.isMuted.mockResolvedValue(true);
      ctx.session.get.mockResolvedValue(
        flow && {
          userId: 'test-user',
          flow,
          step: 'SEND_REGISTER_FORM',
          status: 'ACTIVE',
          data: {},
        },
      );
      expect((await ctx.send('สวัสดี')).text).toBe('');
      await ctx.send('ยกเลิก');
      expect((await ctx.send('')).text).toBe('');
      expect((await ctx.send('x'.repeat(1001))).text).toBe('');
      expect(ctx.session.clear).not.toHaveBeenCalled();
      expect(ctx.registration.handle).not.toHaveBeenCalled();
      expect(ctx.retrieve).not.toHaveBeenCalled();
      expect(ctx.generate).not.toHaveBeenCalled();
    },
  );

  it('a pending admin request (not muted) continues RAG and cancel cannot clear it', async () => {
    const ctx = build({ cached: [pattern()] });
    expect((await ctx.send(question)).text).toBe(pattern().answer);
    expect(ctx.retrieve).toHaveBeenCalledTimes(1);
    await ctx.send('cancel');
    expect(ctx.session.clear).not.toHaveBeenCalled();
  });

  it('mute blocks image and sticker processing', async () => {
    const ctx = build();
    ctx.session.isMuted.mockResolvedValue(true);
    const imageRequest = { userId: 'test-user', image: {} } as Parameters<
      ChatbotService['handleImageMessage']
    >[0];
    expect((await ctx.service.handleImageMessage(imageRequest)).text).toBe('');
    expect(
      (
        await ctx.service.handleStickerMessage({
          userId: 'test-user',
          packageId: '1',
          stickerId: '1',
          text: question,
        })
      ).text,
    ).toBe('');
    expect(ctx.retrieve).not.toHaveBeenCalled();
    expect(ctx.generate).not.toHaveBeenCalled();
  });

  it('cancel exits registration even when registration is disabled', async () => {
    const ctx = build({ config: { CAN_REGISTER: 'false' } });
    ctx.session.get.mockResolvedValue({
      userId: 'test-user',
      flow: 'REGISTER',
      step: 'SEND_REGISTER_FORM',
      status: 'ACTIVE',
      data: {},
    });
    expect((await ctx.send('ยกเลิก')).text).toContain('ยกเลิก');
    expect(ctx.session.clear).toHaveBeenCalledWith('test-user');
    expect(ctx.retrieve).not.toHaveBeenCalled();
  });
});
