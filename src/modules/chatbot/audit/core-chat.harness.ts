/**
 * In-process harness for the core chat loop: LINE inbound text/postback ->
 * session/mute -> rule -> rich menu -> retrieval (lexical + micro + vector)
 * -> LLM -> ChatResponse.
 *
 * Everything inside the loop is the real service. Only the boundaries are
 * mocked: Prisma, Redis, the embedding adapter, the generation provider and
 * the LINE Messaging API. No outbound call can leave this process.
 */
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { NotificationService } from '../../admin/notification/notification.service';
import type { RegistrationFlowService } from '../../registration/registration-flow.service';
import type { AiBudgetService } from '../../usage/rate-limit/ai-budget.service';
import type { UsersAiProviderService } from '../../ai/users-ai-provider.service';
import type { EmbeddingService } from '../../ai/embeding/embedding.service';
import type { AnswerPatternVectorRepository } from '../../ai/embeding/answer-pattern-vector.repository';
import type { MicroKnowledgeVectorRepository } from '../../ai/embeding/micro-knowledge-vector.repository';
import type { AnswerPatternCacheService } from '../knowledge/answer-pattern-cache.service';
import type { RichMenuReplyCacheService } from '../menu/rich-menu-reply-cache.service';
import type { KnowledgeRecord } from '../knowledge/answer-pattern.service';

import { AnswerPatternService } from '../knowledge/answer-pattern.service';
import { MicroKnowledgeService } from '../knowledge/micro-knowledge.service';
import { SemanticSearchService } from '../knowledge/semantic-search.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import { RuleIntentService } from '../rule-intent.service';
import { AiIntentClassifierService } from '../ai-intent-classifier.service';
import { IntentRouterService } from '../intent-router.service';
import { AiChatService } from '../aichat.service';
import { ChatbotService } from '../chatbot.service';
import { UserSessionService } from '../user-session.service';
import { ReplyTemplateService } from '../reply-template.service';
import { StickerIntentService } from '../sticker-intent.service';

export type VectorRow = {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  intentKey?: string | null;
  entityKey?: string | null;
  topicKey?: string | null;
  answer: string;
  priority?: number;
  score: number;
  renderMode?: 'direct' | 'rewrite';
  tenantId?: string | null;
  language?: string;
  questionExamples?: string[];
};

export type HarnessOptions = {
  env?: Record<string, string>;
  patterns?: KnowledgeRecord[];
  micro?: KnowledgeRecord[];
  patternVectors?: VectorRow[];
  microVectors?: VectorRow[];
  /** Cache snapshot used by the zero-DB DIRECT path. Defaults to `patterns`. */
  cached?: KnowledgeRecord[] | null;
  menuReplies?: { key: string; label: string; replyText: string }[];
  /** Queue of provider replies, consumed in order. */
  generations?: string[];
  aiSetting?: Record<string, unknown> | null;
  budgetAllows?: boolean;
};

export const pattern = (
  overrides: Partial<KnowledgeRecord> = {},
): KnowledgeRecord => ({
  id: 'pattern-1',
  tenantId: null,
  title: 'แพตเทิร์น',
  description: null,
  category: null,
  intentKey: null,
  entityKey: null,
  topicKey: null,
  keywords: [],
  questionExamples: [],
  answer: 'คำตอบ',
  language: 'th',
  renderMode: 'DIRECT',
  priority: 0,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

export const vector = (overrides: Partial<VectorRow> = {}): VectorRow => ({
  id: 'vector-1',
  title: 'เวกเตอร์',
  description: null,
  category: null,
  intentKey: null,
  entityKey: null,
  topicKey: null,
  answer: 'คำตอบเวกเตอร์',
  priority: 0,
  score: 0.8,
  renderMode: 'direct',
  tenantId: null,
  language: 'th',
  questionExamples: [],
  ...overrides,
});

/** Minimal Redis good enough for sessions, mute and context keys. */
export function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    getex: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    lrange: jest.fn(() => Promise.resolve([] as string[])),
    eval: jest.fn(() => Promise.resolve(1)),
  };
}

export function buildHarness(options: HarnessOptions = {}) {
  const env: Record<string, string> = {
    AUTO_MUTE_WHEN_REPLY: '10m',
    ...options.env,
  };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      if (env[key] === undefined) throw new Error(`missing ${key}`);
      return env[key];
    },
  } as unknown as ConfigService;

  const patterns = options.patterns ?? [];
  const micro = options.micro ?? [];
  const cached = options.cached === undefined ? patterns : options.cached;

  const answerPatternFindMany = jest.fn(({ take }: { take?: number } = {}) =>
    Promise.resolve(patterns.slice(0, take ?? patterns.length)),
  );
  const microFindMany = jest.fn(({ take }: { take?: number } = {}) =>
    Promise.resolve(micro.slice(0, take ?? micro.length)),
  );
  const conversationUpdateMany = jest.fn(() => Promise.resolve({ count: 1 }));

  const prisma = {
    answerPattern: { findMany: answerPatternFindMany },
    microKnowledge: { findMany: microFindMany },
    aiSetting: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.aiSetting === undefined
            ? { systemPrompt: null, fallbackMessage: null, promptVersion: 1 }
            : options.aiSetting,
        ),
      ),
    },
    lineConversation: { updateMany: conversationUpdateMany },
  } as unknown as PrismaService;

  // --- provider boundary ----------------------------------------------------
  const generations = [...(options.generations ?? [])];
  const generate = jest.fn(() => {
    const text = generations.shift();
    if (text === undefined) {
      throw new Error('harness: provider called more times than scripted');
    }
    return Promise.resolve({ text });
  });
  const provider = { generate } as unknown as UsersAiProviderService;

  const embedQuery = jest.fn(() =>
    Promise.resolve({ values: [0.1, 0.2, 0.3], model: 'test-embedding' }),
  );
  const embedding = { embedQuery } as unknown as EmbeddingService;

  const patternVectorSearch = jest.fn(() =>
    Promise.resolve(options.patternVectors ?? []),
  );
  const microVectorSearch = jest.fn(() =>
    Promise.resolve(options.microVectors ?? []),
  );

  const tryConsume = jest.fn(() =>
    Promise.resolve(options.budgetAllows ?? true),
  );
  const budget = { tryConsume } as unknown as AiBudgetService;

  // --- real services --------------------------------------------------------
  const answerPatterns = new AnswerPatternService(prisma, config);
  const cacheGetAll = jest.fn(() => cached ?? []);
  const patternCache = {
    getAll: cacheGetAll,
  } as unknown as AnswerPatternCacheService;
  const microKnowledge = new MicroKnowledgeService(
    prisma,
    answerPatterns,
    config,
  );
  const semantic = new SemanticSearchService(
    embedding,
    { search: patternVectorSearch } as unknown as AnswerPatternVectorRepository,
    { search: microVectorSearch } as unknown as MicroKnowledgeVectorRepository,
    config,
  );
  const retrieval = new KnowledgeRetrievalService(
    answerPatterns,
    patternCache,
    semantic,
    microKnowledge,
    config,
  );

  const menuRows = options.menuReplies ?? [];
  const menuCache = {
    byKey: (key: string) => {
      const row = menuRows.find((reply) => reply.key === key);
      return row ? { ...row, via: 'POSTBACK' as const } : null;
    },
    byLabel: (text: string) => {
      const row = menuRows.find(
        (reply) =>
          reply.label.trim().toLocaleLowerCase() ===
          text.trim().toLocaleLowerCase(),
      );
      return row ? { ...row, via: 'LABEL' as const } : null;
    },
    labels: () => menuRows.map((reply) => reply.label),
  } as unknown as RichMenuReplyCacheService;

  const classifier = new AiIntentClassifierService(budget, provider);
  const router = new IntentRouterService(
    new RuleIntentService(),
    retrieval,
    classifier,
    menuCache,
  );
  const aiChat = new AiChatService(prisma, retrieval, budget, provider, config);

  const redis = fakeRedis();
  const notifyAdminRequired = jest.fn(() => Promise.resolve(undefined));
  const sessions = new UserSessionService(
    redis as never,
    config,
    { notifyAdminRequired } as unknown as NotificationService,
    prisma,
  );

  const registrationStart = jest.fn(() => Promise.resolve('เริ่มสมัคร'));
  const registrationHandle = jest.fn(() => Promise.resolve('กรอกต่อ'));
  const registration = {
    start: registrationStart,
    handle: registrationHandle,
  } as unknown as RegistrationFlowService;

  const chatbot = new ChatbotService(
    router,
    sessions,
    registration,
    new ReplyTemplateService(),
    aiChat,
    new StickerIntentService(),
    menuCache,
    config,
  );

  /** System instruction of the nth (default: last) generation call. */
  const systemInstruction = (index = -1): string => {
    const calls = generate.mock.calls as unknown as {
      systemInstruction: string;
    }[][];
    const call = index < 0 ? calls.at(index) : calls[index];
    return call?.[0]?.systemInstruction ?? '';
  };

  const ragContext = (index = -1): { source: string; id: string }[] => {
    const block = /<ragContext>\n([\s\S]*?)\n<\/ragContext>/.exec(
      systemInstruction(index),
    );
    return block
      ? (JSON.parse(block[1]) as { source: string; id: string }[])
      : [];
  };

  return {
    chatbot,
    router,
    retrieval,
    aiChat,
    sessions,
    answerPatterns,
    redis,
    spies: {
      generate,
      embedQuery,
      tryConsume,
      patternVectorSearch,
      microVectorSearch,
      answerPatternFindMany,
      microFindMany,
      cacheGetAll,
      conversationUpdateMany,
      notifyAdminRequired,
      registrationStart,
      registrationHandle,
    },
    /** System instruction of the nth (default: last) generation call. */
    systemInstruction,
    ragContext,
  };
}

export type Harness = ReturnType<typeof buildHarness>;
