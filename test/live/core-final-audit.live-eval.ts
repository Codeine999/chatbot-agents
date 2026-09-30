/** Opt-in live core evaluation. Reads KB/settings only; no LINE, Redis or ledger writes.
 * Provider API calls are real and incur provider charges. All workflow side effects
 * are mocked by the same core harness used in the deterministic regression tests.
 * Run with LIVE_CORE_AUDIT=1 and --testPathPatterns=core-final-audit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AiProviderService } from '../../src/modules/ai/ai-provider.service';
import { AiProviderSettingsService } from '../../src/modules/ai/ai-provider-settings.service';
import { GeminiAiProvider } from '../../src/ai-provider/providers/gemini-ai.provider';
import { MaxPlusProvider } from '../../src/ai-provider/providers/maxPlus-ai.provider';
import { OpenAiProvider } from '../../src/ai-provider/providers/openai-ai.provider';
import { AnthropicAiProvider } from '../../src/ai-provider/providers/anthropic-ai.provider';
import { GeminiEmbeddingAdapter } from '../../src/infra/embedding/gemini-embedding.adapter';
import { AnswerPatternVectorRepository } from '../../src/modules/ai/embeding/answer-pattern-vector.repository';
import { MicroKnowledgeVectorRepository } from '../../src/modules/ai/embeding/micro-knowledge-vector.repository';
import { knowledgeScope } from '../../src/modules/chatbot/knowledge/knowledge-scope';
import { aiSettingTenantId } from '../../src/modules/ai/ai-setting/ai-setting-config';
import { buildHarness } from '../../src/modules/chatbot/audit/core-chat.harness';
import type { AiGenerateRequest } from '../../src/ai-provider/types/ai-provider.types';
import type {
  ChatContextMessage,
  KnowledgeRetrievalResult,
} from '../../src/modules/chatbot/types/chat.types';
import { CLARIFY_MESSAGE } from '../../src/modules/chatbot/constants/knowledge-routing.constants';
import { redactPii } from '../../src/utils/text.utils';
import { CASES, PII_PROBES, type Outcome } from './chatbot-answer.cases';

const enabled = process.env.LIVE_CORE_AUDIT === '1';
const selected = CASES.filter(
  (c) =>
    !process.env.LIVE_EVAL_FILTER ||
    new RegExp(process.env.LIVE_EVAL_FILTER).test(c.id),
);
const out =
  process.env.LIVE_EVAL_OUT ??
  join(tmpdir(), 'core-final-audit', String(Date.now()));

(enabled ? describe : describe.skip)('read-only live core audit', () => {
  let db: PrismaService;
  let config: ConfigService;
  let provider: AiProviderService;
  let embedding: GeminiEmbeddingAdapter;
  let fixtures: Parameters<typeof buildHarness>[0];
  let selection: {
    provider: 'GEMINI' | 'OPENAI' | 'ANTHROPIC' | 'MAXPLUS';
    model: string;
  };
  const results: unknown[] = [];
  const embeddingCache = new Map<
    string,
    Awaited<ReturnType<GeminiEmbeddingAdapter['embed']>>
  >();

  beforeAll(async () => {
    await ConfigModule.forRoot({ isGlobal: true });
    config = new ConfigService();
    Logger.overrideLogger(false);
    db = new PrismaService(config);
    const scope = knowledgeScope(config);
    const [patterns, micro, aiSetting, setting] = await Promise.all([
      db.answerPattern.findMany({
        where: { active: true, ...scope },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        take: 500,
      }),
      db.microKnowledge.findMany({
        where: { active: true, ...scope },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        take: 500,
      }),
      db.aiSetting.findFirst({
        where: { active: true, tenantId: aiSettingTenantId(config) },
        orderBy: { updatedAt: 'desc' },
      }),
      db.aiProviderSetting.findUniqueOrThrow({ where: { scope: 'USER' } }),
    ]);
    // Override this audit run only; never change the DB setting.
    const auditProvider = process.env.LIVE_AUDIT_PROVIDER;
    if (auditProvider && !['GEMINI', 'OPENAI', 'ANTHROPIC', 'MAXPLUS'].includes(auditProvider)) {
      throw new Error('Invalid LIVE_AUDIT_PROVIDER');
    }
    selection = {
      provider: (auditProvider ?? setting.provider) as typeof selection.provider,
      model: process.env.LIVE_AUDIT_MODEL ?? setting.model,
    };
    fixtures = {
      patterns,
      micro,
      aiSetting,
      // Stable menu fixtures: no dependency on the operator's current menu.
      menuReplies: [
        { key: 'test1', label: 'test1', replyText: 'สวัสดี' },
        { key: 'test2', label: 'test2', replyText: 'test2' },
      ],
      env: Object.fromEntries(
        [
          'KNOWLEDGE_TENANT_ID',
          'KNOWLEDGE_LANGUAGE',
          'AI_SETTING_TENANT_ID',
          'CAN_REGISTER',
          'KNOWLEDGE_VECTOR_CANDIDATE_MIN_SIMILARITY',
          'KNOWLEDGE_LEXICAL_CANDIDATE_MIN_SCORE',
        ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
      ),
    };
    provider = new AiProviderService(
      {} as AiProviderSettingsService,
      [
        new GeminiAiProvider(config),
        new MaxPlusProvider(config),
        new OpenAiProvider(config),
        new AnthropicAiProvider(config),
      ],
      config,
    );
    embedding = new GeminiEmbeddingAdapter(config);
    mkdirSync(out, { recursive: true });
    process.stderr.write(
      `Live audit ${selection.provider}/${selection.model}; AP=${patterns.length} MK=${micro.length}; ${selected.length} cases; ${out}\n`,
    );
  }, 20000);

  afterAll(async () => {
    if (results.length)
      writeFileSync(
        join(out, 'results.json'),
        JSON.stringify({ selection, results }, null, 2),
      );
    await db?.$disconnect();
  });

  test.each(selected)(
    '$id [$group]',
    async (c) => {
      const h = buildHarness(fixtures);
      let currentEmbedding: Awaited<
        ReturnType<GeminiEmbeddingAdapter['embed']>
      >;
      let retrieval: KnowledgeRetrievalResult | undefined;
      let calls: {
        kind: string;
        raw: string;
        inputTokens: number;
        outputTokens: number;
        error?: string;
        messages: { role: string; text: string }[];
        systemCharacters: number;
      }[] = [];
      let payloads: string[] = [];
      const retrieve = h.retrieval.retrieve.bind(h.retrieval);
      jest
        .spyOn(h.retrieval, 'retrieve')
        .mockImplementation(async (...args) => {
          const found = await retrieve(...args);
          retrieval = found;
          return found;
        });
      (h.spies.embedQuery as jest.Mock).mockImplementation(
        async (query: string) => {
          payloads.push(query);
          const cached = embeddingCache.get(query);
          currentEmbedding =
            cached ??
            (await embedding.embed({ text: query, task: 'RETRIEVAL_QUERY' }));
          embeddingCache.set(query, currentEmbedding);
          return currentEmbedding;
        },
      );
      h.spies.patternVectorSearch.mockImplementation(async () =>
        new AnswerPatternVectorRepository(db).search(
          currentEmbedding.values,
          currentEmbedding.model,
          20,
          knowledgeScope(config),
        ),
      );
      h.spies.microVectorSearch.mockImplementation(async () =>
        new MicroKnowledgeVectorRepository(db).search(
          currentEmbedding.values,
          currentEmbedding.model,
          20,
          knowledgeScope(config),
        ),
      );
      (h.spies.generate as jest.Mock).mockImplementation(
        async (request: AiGenerateRequest) => {
          payloads.push(JSON.stringify(request));
          const kind = request.systemInstruction?.includes(
            '"decision":"ANSWER"',
          )
            ? 'RAG'
            : request.systemInstruction?.includes('You classify')
              ? 'CLASSIFIER'
              : 'GENERAL';
          const requestInfo = {
            messages: request.messages.map((message) => ({
              role: message.role,
              text: redactPii(message.text),
            })),
            systemCharacters: request.systemInstruction?.length ?? 0,
          };
          try {
            const result = await provider.generateWith(
              selection.provider,
              selection.model,
              request,
            );
            calls.push({
              ...requestInfo,
              kind,
              raw: redactPii(result.text),
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            });
            return result;
          } catch (error) {
            calls.push({
              ...requestInfo,
              kind,
              raw: '',
              inputTokens: 0,
              outputTokens: 0,
              error: error instanceof Error ? error.message : 'provider error',
            });
            throw error;
          }
        },
      );
      if (c.setup === 'ADMIN_MUTE') await h.sessions.mute('audit-user');
      if (c.setup === 'REGISTER_SESSION')
        await h.sessions.set('audit-user', {
          userId: 'audit-user',
          flow: 'REGISTER',
          step: 'ASK_NAME',
          status: 'ACTIVE',
          data: {},
        });
      let history: ChatContextMessage[] = [];
      const turns: {
        question: string;
        answer: string;
        outcome: Outcome;
        route?: string;
        match?: string;
        reason?: string;
        evidence: string[];
        candidates: unknown[];
        calls: typeof calls;
        ms: number;
        contextPolicy: string;
      }[] = [];
      const problems: string[] = [];
      for (const raw of c.turns) {
        const turn =
          typeof raw === 'string' ? { kind: 'text' as const, text: raw } : raw;
        retrieval = undefined;
        calls = [];
        payloads = [];
        h.spies.notifyAdminRequired.mockClear();
        const start = Date.now();
        const base = { userId: 'audit-user', recentMessages: history };
        const answer =
          turn.kind === 'sticker'
            ? await h.chatbot.handleStickerMessage({
                ...base,
                packageId: '446',
                stickerId: '1988',
                text: turn.text,
                keywords: turn.keywords,
              })
            : await h.chatbot.handleTextMessage({
                ...base,
                text: turn.text,
                postbackData: turn.kind === 'postback' ? turn.data : undefined,
              });
        const found = retrieval as KnowledgeRetrievalResult | undefined;
        const outcome: Outcome = !answer.text
          ? 'SILENT'
          : h.spies.notifyAdminRequired.mock.calls.length
            ? 'ADMIN'
            : answer.text === CLARIFY_MESSAGE
              ? 'CLARIFY'
              : answer.source === 'KNOWLEDGE'
                ? calls.some((x) => x.kind === 'RAG')
                  ? 'RAG'
                  : 'DIRECT'
                : answer.source === 'AI'
                  ? 'GENERAL'
                  : answer.source === 'REGISTRATION'
                    ? 'REGISTER'
                    : answer.source === 'RULE'
                      ? 'RULE'
                      : 'SYSTEM';
        turns.push({
          question: turn.text ?? '[sticker]',
          contextPolicy: answer.contextPolicy,
          answer: answer.text,
          outcome,
          route: found?.route,
          match: found?.matchType,
          reason: found?.fallbackReason,
          evidence:
            found?.selectedItems.map(
              (i) =>
                `${i.source === 'ANSWER_PATTERN' ? 'AP' : 'MK'}:${i.source === 'ANSWER_PATTERN' ? i.id.slice(0, 8) : i.id.slice(-4)}`,
            ) ?? [],
          candidates:
            found?.items.map((i) => ({
              source: i.source,
              title: i.title,
              score: i.score,
              lexical: i.metadata?.rawScore,
              vector: i.metadata?.vectorSimilarity,
            })) ?? [],
          calls: [...calls],
          ms: Date.now() - start,
        });
        for (const probe of PII_PROBES)
          if (payloads.some((p) => p.includes(probe)))
            problems.push('PII_LEAK');
        if (answer.contextPolicy === 'CLEAR') history = [];
        if (answer.contextPolicy === 'INCLUDE')
          history = [
            ...history,
            {
              role: 'user',
              text: turn.text ?? '[sticker]',
              source: 'USER',
              createdAt: 1,
            },
            {
              role: 'assistant',
              text: answer.text,
              source: answer.source,
              createdAt: 2,
            },
          ].slice(-6) as ChatContextMessage[];
      }
      const last = turns.at(-1)!;
      if (!c.expect.includes(last.outcome))
        problems.push(
          `ROUTE expected=${c.expect.join('|')} got=${last.outcome}`,
        );
      const text = last.answer.replace(/(\d),(?=\d{3}(?:\D|$))/gu, '$1');
      const match = (p: string | RegExp) =>
        typeof p === 'string' ? text.includes(p) : p.test(text);
      if (last.outcome !== 'ADMIN')
        for (const p of c.facts ?? [])
          if (!match(p)) problems.push(`MISSING_FACT ${String(p)}`);
      for (const p of c.forbid ?? [])
        if (match(p)) problems.push(`FORBIDDEN ${String(p)}`);
      // Surface missing evidence even when an answer happens to contain the gold text.
      if (
        c.gold?.length &&
        ['DIRECT', 'RAG'].includes(last.outcome) &&
        !last.evidence.some((e) => c.gold!.includes(e))
      )
        problems.push('GOLD_MISSING');
      results.push({
        id: c.id,
        group: c.group,
        expected: c.expect,
        note: c.note,
        problems,
        turns,
      });
      writeFileSync(
        join(out, 'results.json'),
        JSON.stringify({ selection, results }, null, 2),
      );
      process.stderr.write(
        `${problems.length ? 'FAIL' : 'PASS'} ${c.id}: ${problems.join('; ')} ${JSON.stringify(last.answer.slice(0, 110))}\n`,
      );
      expect(problems).toEqual([]);
    },
    120000,
  );
});
