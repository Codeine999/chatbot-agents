/**
 * Live answer eval: real DB knowledge, real embeddings, real configured model.
 * Boots ChatbotModule only (never AppModule), so no LINE worker starts and no
 * LINE message is sent. Every provider call is billed to the dev wallet.
 *
 *   npm run test:live-eval
 *   LIVE_EVAL_FILTER='^B|kb-gap' npm run test:live-eval
 *
 * Report: $LIVE_EVAL_OUT or <tmpdir>/chatbot-live-eval/<run>/report.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, type LoggerService } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type Redis from 'ioredis';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { RedisModule, REDIS_CLIENT } from '../../src/infra/redis/redis.module';
import { RateLimitModule } from '../../src/modules/usage/rate-limit/rate-limit.module';
import { AiProviderModule } from '../../src/modules/ai/ai-provider.module';
import { CreditServiceModule } from '../../src/modules/usage/credit-point/credit.module';
import { ChatbotModule } from '../../src/modules/chatbot/chatbot.module';
import { ChatbotService } from '../../src/modules/chatbot/chatbot.service';
import { AiChatService } from '../../src/modules/chatbot/aichat.service';
import { IntentRouterService } from '../../src/modules/chatbot/intent-router.service';
import { UserSessionService } from '../../src/modules/chatbot/user-session.service';
import { UsersAiProviderService } from '../../src/modules/ai/users-ai-provider.service';
import { EmbeddingService } from '../../src/modules/ai/embeding/embedding.service';
import { CLARIFY_MESSAGE } from '../../src/modules/chatbot/constants/knowledge-routing.constants';
import type {
  ChatContextMessage,
  ChatResponse,
  RouteDecision,
} from '../../src/modules/chatbot/types/chat.types';
import {
  CASES,
  PII_PROBES,
  type EvalCase,
  type Outcome,
  type Turn,
} from './chatbot-answer.cases';

const RUN = process.env.LIVE_EVAL_RUN ?? Date.now().toString(36);
const OUT =
  process.env.LIVE_EVAL_OUT ?? join(tmpdir(), 'chatbot-live-eval', RUN);
const FILTER = process.env.LIVE_EVAL_FILTER
  ? new RegExp(process.env.LIVE_EVAL_FILTER, 'u')
  : undefined;
const PAUSE_MS = Number(process.env.LIVE_EVAL_PAUSE_MS ?? 400);
const SELECTED_CASES = CASES.filter(
  (c) => !FILTER || FILTER.test(c.id) || FILTER.test(c.group),
);

type ProviderCall = {
  kind: 'GROUNDED' | 'CLASSIFIER' | 'GENERAL';
  ms: number;
  /** provider/model that actually answered (DB setting, not GEMINI_MODEL). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Grounded calls only: what the model decided before validation. */
  decision?: string;
  error?: string;
};

type TurnRecord = {
  input: string;
  event: Turn['kind'];
  outcome: Outcome;
  action?: string;
  route?: string;
  matchType?: string;
  fallbackReason?: string;
  selected: string[];
  answer: string;
  source: string;
  calls: ProviderCall[];
  ms: number;
  error?: string;
};

type CaseResult = {
  id: string;
  group: string;
  expect: Outcome[];
  note?: string;
  pass: boolean;
  problems: string[];
  turns: TurnRecord[];
};

const logs: string[] = [];
const capture: LoggerService = {
  log: (m: unknown, c?: string) => logs.push(`[log][${c}] ${String(m)}`),
  debug: (m: unknown, c?: string) => logs.push(`[debug][${c}] ${String(m)}`),
  warn: (m: unknown, c?: string) => logs.push(`[warn][${c}] ${String(m)}`),
  error: (m: unknown, c?: string) => logs.push(`[error][${c}] ${String(m)}`),
  verbose: (m: unknown, c?: string) =>
    logs.push(`[verbose][${c}] ${String(m)}`),
};
const say = (line: string) => process.stderr.write(`${line}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** `AP:<id prefix>` / `MK:<id suffix>`, matching the gold labels in the cases. */
const label = (source: string, id: string) =>
  source === 'ANSWER_PATTERN' ? `AP:${id.slice(0, 8)}` : `MK:${id.slice(-4)}`;

const normalizeAnswer = (text: string) =>
  text.replace(/(\d),(?=\d{3}(?:\D|$))/gu, '$1');

const matches = (text: string, pattern: string | RegExp) =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

const describePattern = (pattern: string | RegExp) =>
  typeof pattern === 'string' ? `"${pattern}"` : String(pattern);

const toTurn = (turn: Turn | string): Turn =>
  typeof turn === 'string' ? { kind: 'text', text: turn } : turn;

const inputOf = (turn: Turn) =>
  turn.kind === 'sticker'
    ? (turn.text ?? `[sticker ${turn.keywords?.join(',') ?? ''}]`)
    : turn.text;

jest.setTimeout(180_000);

describe(`live chatbot answer eval (${RUN})`, () => {
  let moduleRef: TestingModule;
  let chatbot: ChatbotService;
  let sessions: UserSessionService;
  let redis: Redis;
  let fallbackText = '';
  const results: CaseResult[] = [];

  // Per-turn instrumentation, reset before each turn.
  let calls: ProviderCall[] = [];
  let payloads: string[] = [];
  let decision: RouteDecision | undefined;
  let adminRequested = false;

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    Logger.overrideLogger(capture);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        RateLimitModule,
        AiProviderModule,
        CreditServiceModule,
        ChatbotModule,
      ],
    })
      .setLogger(capture)
      .compile();
    await moduleRef.init();
    Logger.overrideLogger(capture);

    chatbot = moduleRef.get(ChatbotService, { strict: false });
    sessions = moduleRef.get(UserSessionService, { strict: false });
    redis = moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    const router = moduleRef.get(IntentRouterService, { strict: false });
    const provider = moduleRef.get(UsersAiProviderService, { strict: false });
    const embedding = moduleRef.get(EmbeddingService, { strict: false });

    // bind() is untyped here (strictBindCallApply is off), so keep the types.
    const resolve = router.resolve.bind(
      router,
    ) as IntentRouterService['resolve'];
    router.resolve = async (...args: Parameters<typeof resolve>) => {
      const routed = await resolve(...args);
      decision = routed;
      return routed;
    };

    const requestAdmin = sessions.requestAdmin.bind(
      sessions,
    ) as UserSessionService['requestAdmin'];
    sessions.requestAdmin = (userId: string) => {
      adminRequested = true;
      return requestAdmin(userId);
    };

    const embedQuery = embedding.embedQuery.bind(
      embedding,
    ) as EmbeddingService['embedQuery'];
    embedding.embedQuery = (...args: Parameters<typeof embedQuery>) => {
      payloads.push(args[0]);
      return embedQuery(...args);
    };

    const generate = provider.generate.bind(
      provider,
    ) as UsersAiProviderService['generate'];
    provider.generate = async (
      ...[request, context]: Parameters<typeof generate>
    ) => {
      payloads.push(JSON.stringify(request));
      const system = request.systemInstruction ?? '';
      const kind: ProviderCall['kind'] = system.includes('"decision":"ANSWER"')
        ? 'GROUNDED'
        : system.trimStart().startsWith('You classify')
          ? 'CLASSIFIER'
          : 'GENERAL';
      const started = Date.now();
      try {
        const response = await generate(request, context);
        calls.push({
          kind,
          ms: Date.now() - started,
          model: `${response.provider}/${response.model}`,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          decision:
            kind === 'GROUNDED' ? groundedDecision(response.text) : undefined,
        });
        return response;
      } catch (error) {
        calls.push({ kind, ms: Date.now() - started, error: String(error) });
        throw error;
      }
    };

    // The configured fallback text, as a customer would receive it.
    const aiChat = moduleRef.get(AiChatService, { strict: false });
    fallbackText = (await aiChat.answerFallback()).text;
    say(`run=${RUN} cases=${SELECTED_CASES.length} out=${OUT}`);
  });

  afterAll(async () => {
    writeReport(results, fallbackText);
    if (redis) {
      const keys = await redis.keys(`*Ulive${RUN}*`);
      if (keys.length) await redis.del(...keys);
      say(`cleaned ${keys.length} redis keys`);
    }
    await moduleRef?.close();
  });

  test.each(SELECTED_CASES)('$id [$group]', async (c: EvalCase) => {
    const userId = `Ulive${RUN}${c.id}`;
    if (c.setup === 'ADMIN_MUTE') await sessions.mute(userId);
    if (c.setup === 'REGISTER_SESSION')
      await sessions.set(userId, {
        userId,
        flow: 'REGISTER',
        step: 'ASK_NAME',
        status: 'ACTIVE',
        data: {},
      });

    let history: ChatContextMessage[] = [];
    const turns: TurnRecord[] = [];
    const casePayloads: string[] = [];

    for (const [index, raw] of c.turns.entries()) {
      const turn = toTurn(raw);
      calls = [];
      payloads = [];
      decision = undefined;
      adminRequested = false;
      const started = Date.now();
      let response: ChatResponse;
      let error: string | undefined;
      try {
        response = await send(chatbot, turn, {
          userId,
          turnId: `live-${RUN}-${c.id}-${index}`,
          recentMessages: history,
        });
      } catch (thrown) {
        error = String(thrown);
        response = { text: '', source: 'SYSTEM', contextPolicy: 'EXCLUDE' };
      }
      casePayloads.push(...payloads);

      // Set inside the router wrapper; TS cannot see that assignment.
      const routed = decision as RouteDecision | undefined;
      const retrieval = routed?.retrieval;
      const record: TurnRecord = {
        input: inputOf(turn),
        event: turn.kind,
        outcome: outcomeOf(response, calls, adminRequested, fallbackText),
        action: routed?.action,
        route: retrieval?.route,
        matchType: retrieval?.matchType,
        fallbackReason: routed?.fallbackReason ?? retrieval?.fallbackReason,
        selected: (retrieval?.selectedItems ?? []).map((item) =>
          label(item.source, item.id),
        ),
        answer: response.text,
        source: response.source,
        calls: [...calls],
        ms: Date.now() - started,
        error,
      };
      turns.push(record);

      if (response.contextPolicy === 'CLEAR') history = [];
      if (response.contextPolicy === 'INCLUDE' && response.text) {
        const now = Date.now();
        history = [
          ...history,
          {
            role: 'user' as const,
            text: record.input,
            source: 'USER' as const,
            createdAt: now,
          },
          {
            role: 'assistant' as const,
            text: response.text,
            source: response.source,
            createdAt: now,
          },
        ].slice(-6);
      }
      await sleep(PAUSE_MS);
    }

    const problems = grade(c, turns.at(-1)!, casePayloads);
    const result: CaseResult = {
      id: c.id,
      group: c.group,
      expect: c.expect,
      note: c.note,
      pass: problems.length === 0,
      problems,
      turns,
    };
    results.push(result);
    const last = turns.at(-1)!;
    say(
      `${result.pass ? 'PASS' : 'FAIL'} ${c.id} ${last.outcome} ${last.ms}ms ${JSON.stringify(last.answer.slice(0, 70))}`,
    );
    expect(problems).toEqual([]);
  });
});

async function send(
  chatbot: ChatbotService,
  turn: Turn,
  base: {
    userId: string;
    turnId: string;
    recentMessages: ChatContextMessage[];
  },
): Promise<ChatResponse> {
  switch (turn.kind) {
    case 'text':
      return chatbot.handleTextMessage({ ...base, text: turn.text });
    case 'postback':
      return chatbot.handleTextMessage({
        ...base,
        text: turn.text,
        postbackData: turn.data,
      });
    case 'sticker':
      return chatbot.handleStickerMessage({
        ...base,
        packageId: '446',
        stickerId: '1988',
        text: turn.text,
        keywords: turn.keywords,
      });
  }
}

function groundedDecision(text: string): string {
  try {
    const parsed = JSON.parse(text) as { decision?: unknown };
    return typeof parsed.decision === 'string'
      ? parsed.decision
      : 'NO_DECISION';
  } catch {
    return 'INVALID_JSON';
  }
}

function outcomeOf(
  response: ChatResponse,
  calls: readonly ProviderCall[],
  adminRequested: boolean,
  fallbackText: string,
): Outcome {
  if (!response.text) return 'SILENT';
  if (adminRequested || response.text === fallbackText) return 'ADMIN';
  if (response.text === CLARIFY_MESSAGE) return 'CLARIFY';
  if (response.source === 'KNOWLEDGE')
    return calls.some((call) => call.kind === 'GROUNDED') ? 'RAG' : 'DIRECT';
  if (response.source === 'AI') return 'GENERAL';
  if (response.source === 'RULE') return 'RULE';
  if (response.source === 'REGISTRATION') return 'REGISTER';
  return 'SYSTEM';
}

function grade(
  c: EvalCase,
  last: TurnRecord,
  payloads: readonly string[],
): string[] {
  const problems: string[] = [];
  if (last.error) problems.push(`ERROR ${last.error}`);

  const routeOk = c.expect.includes(last.outcome);
  if (!routeOk)
    problems.push(
      `WRONG_ROUTE expected ${c.expect.join('|')} got ${last.outcome}` +
        ` (action=${last.action ?? '-'} route=${last.route ?? '-'}` +
        ` match=${last.matchType ?? '-'} fallback=${last.fallbackReason ?? '-'}` +
        `${groundedSummary(last)})`,
    );

  const answer = normalizeAnswer(last.answer);
  if (routeOk && last.outcome !== 'ADMIN') {
    for (const fact of c.facts ?? [])
      if (!matches(answer, fact))
        problems.push(`MISSING_FACT ${describePattern(fact)}`);
  }
  for (const banned of c.forbid ?? [])
    if (matches(answer, banned))
      problems.push(`FORBIDDEN ${describePattern(banned)}`);

  if (
    routeOk &&
    (last.outcome === 'DIRECT' || last.outcome === 'RAG') &&
    c.gold?.length &&
    last.selected.length &&
    !last.selected.some((key) => c.gold!.includes(key))
  )
    problems.push(`GOLD_MISSING selected=${last.selected.join(',')}`);

  for (const probe of PII_PROBES)
    if (payloads.some((payload) => payload.includes(probe)))
      problems.push(`PII_LEAK "${probe}" reached a provider`);

  return problems;
}

function groundedSummary(turn: TurnRecord): string {
  const grounded = turn.calls.filter((call) => call.kind === 'GROUNDED');
  const classifier = turn.calls.some((call) => call.kind === 'CLASSIFIER');
  return [
    classifier ? ' classifier=called' : '',
    grounded.length
      ? ` llm=${grounded.map((call) => call.decision ?? call.error).join('/')}`
      : '',
  ].join('');
}

const CALL_CODE: Record<ProviderCall['kind'], string> = {
  GROUNDED: 'R',
  CLASSIFIER: 'C',
  GENERAL: 'G',
};

function writeReport(results: CaseResult[], fallbackText: string): void {
  if (!results.length) return;
  const passed = results.filter((r) => r.pass).length;
  const pct = (n: number, d: number) =>
    d ? `${((100 * n) / d).toFixed(1)}%` : '-';
  const allTurns = results.flatMap((r) => r.turns);
  const allCalls = allTurns.flatMap((t) => t.calls);
  const cell = (text: string, max = 90) =>
    text.replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').slice(0, max);

  const groups = [...new Set(results.map((r) => r.group))];
  const problemKinds = new Map<string, number>();
  for (const r of results)
    for (const p of r.problems) {
      const kind = p.split(' ')[0];
      problemKinds.set(kind, (problemKinds.get(kind) ?? 0) + 1);
    }
  const byKind = (kind: ProviderCall['kind']) => {
    const list = allCalls.filter((call) => call.kind === kind);
    const ok = list.filter((call) => !call.error);
    return {
      count: list.length,
      errors: list.length - ok.length,
      avgMs: ok.length
        ? Math.round(ok.reduce((s, call) => s + call.ms, 0) / ok.length)
        : 0,
      input: ok.reduce((s, call) => s + (call.inputTokens ?? 0), 0),
      output: ok.reduce((s, call) => s + (call.outputTokens ?? 0), 0),
    };
  };
  const latencies = results
    .map((r) => r.turns.at(-1)!.ms)
    .sort((a, b) => a - b);
  const p = (q: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];

  const lines: string[] = [
    `# Live chatbot answer eval — ${RUN}`,
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Model: ${[...new Set(allCalls.flatMap((call) => call.model ?? []))].join(', ') || '-'}`,
    `- Result: **${passed}/${results.length} passed (${pct(passed, results.length)})**`,
    `- Graded-turn latency: p50 ${p(0.5)} ms, p90 ${p(0.9)} ms, max ${latencies.at(-1)} ms`,
    `- Fallback text: ${JSON.stringify(fallbackText)}`,
    '',
    '## By group',
    '',
    '| Group | Pass | Total | Rate |',
    '| --- | --- | --- | --- |',
    ...groups.map((g) => {
      const list = results.filter((r) => r.group === g);
      const ok = list.filter((r) => r.pass).length;
      return `| ${g} | ${ok} | ${list.length} | ${pct(ok, list.length)} |`;
    }),
    '',
    '## Problem types',
    '',
    '| Problem | Cases |',
    '| --- | --- |',
    ...[...problemKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `| ${kind} | ${n} |`),
    '',
    '## Provider calls (all turns)',
    '',
    '| Kind | Calls | Errors | Avg ms | Input tokens | Output tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(['GROUNDED', 'CLASSIFIER', 'GENERAL'] as const).map((kind) => {
      const s = byKind(kind);
      return `| ${kind} | ${s.count} | ${s.errors} | ${s.avgMs} | ${s.input} | ${s.output} |`;
    }),
    '',
    '## Failures',
    '',
  ];

  for (const r of results.filter((x) => !x.pass)) {
    const last = r.turns.at(-1)!;
    lines.push(
      `### ${r.id} [${r.group}]`,
      '',
      ...r.turns.map(
        (t, i) =>
          `${i + 1}. \`${t.event}\` ${JSON.stringify(t.input)} → **${t.outcome}**`,
      ),
      '',
      `- Expected: ${r.expect.join(' | ')}${r.note ? ` — ${r.note}` : ''}`,
      ...r.problems.map((problem) => `- ${problem}`),
      `- Evidence: ${last.selected.join(', ') || '-'}`,
      `- Answer: ${JSON.stringify(last.answer)}`,
      '',
    );
  }

  lines.push(
    '## All cases',
    '',
    '| Case | Group | Result | Outcome | ms | LLM calls | Answer |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => {
      const last = r.turns.at(-1)!;
      return `| ${r.id} | ${r.group} | ${r.pass ? 'PASS' : 'FAIL'} | ${last.outcome} | ${last.ms} | ${last.calls.map((c) => CALL_CODE[c.kind]).join('') || '-'} | ${cell(last.answer)} |`;
    }),
    '',
    'LLM calls on the graded turn: R = grounded RAG answer, C = classifier, G = general chat. Full detail is in results.json.',
  );

  writeFileSync(join(OUT, 'report.md'), lines.join('\n'));
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, 'logs.txt'), logs.join('\n'));
  say(
    `\n${passed}/${results.length} passed — report: ${join(OUT, 'report.md')}`,
  );
}
