/**
 * Preloaded into the real compiled app (`node -r test/load/preload.cjs <dist>/src/main.js`)
 * for internal load tests. It never lets the process reach LINE or an AI provider:
 *
 * - every outbound fetch/http(s) request to a non-local host throws, except
 * - api.line.me / api-data.line.me, answered by an in-process fake LINE API,
 * - the generation and embedding adapters are replaced by fakes with
 *   configurable latency and realistic token usage, so reservation,
 *   settlement, ledger and usage rows are written exactly as in production.
 *
 * Counters go to the load Redis (`load:*`) so verify-load.mjs can compare
 * provider calls and LINE sends with what the app recorded.
 */
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');

const dist = process.env.LOAD_DIST;
if (!dist) throw new Error('LOAD_DIST must point at the compiled app root');
if (!/load|staging/i.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('Refusing to run: DATABASE_URL must name a load/staging database');
}

const Redis = require(require.resolve('ioredis', { paths: [process.cwd()] }));
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: false,
});
const count = (key, by = 1) => void redis.incrby(`load:${key}`, by).catch(() => undefined);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LINE_HOSTS = new Set(['api.line.me', 'api-data.line.me']);
const REPLY_TOKEN_TTL_MS = Number(process.env.LOAD_REPLY_TOKEN_TTL_MS ?? 60_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** "min-max" milliseconds, uniformly distributed. */
const latency = (name, fallback) => {
  const [min, max] = (process.env[name] ?? fallback).split('-').map(Number);
  return min + Math.random() * (max - min);
};
const blocked = (where) => {
  count('blocked');
  return new Error(`load harness blocked external call to ${where}`);
};

// ---------------------------------------------------------------- network guard
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (LOCAL_HOSTS.has(url.hostname)) return realFetch(input, init);
  if (LINE_HOSTS.has(url.hostname)) return fakeLine(url, init);
  throw blocked(url.hostname);
};
for (const mod of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = mod[method];
    mod[method] = function guarded(...args) {
      const target = args[0];
      const host =
        typeof target === 'string' || target instanceof URL
          ? new URL(target).hostname
          : (target?.hostname ?? target?.host ?? 'localhost');
      if (!LOCAL_HOSTS.has(String(host).replace(/:\d+$/, ''))) throw blocked(host);
      return original.apply(this, args);
    };
  }
}

// ---------------------------------------------------------------- fake LINE API
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function fakeLine(url, init) {
  const route = url.pathname;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  await sleep(latency('LOAD_LINE_MS', '80-250'));

  if (route === '/v2/bot/message/reply') {
    // Generator tokens are `rt.<issuedAtMs>.<id>`: single-use and short-lived like LINE's.
    const issuedAt = Number(String(body.replyToken).split('.')[1]);
    const fresh = Date.now() - issuedAt < REPLY_TOKEN_TTL_MS;
    const first = await redis.set(`load:rt:${body.replyToken}`, '1', 'EX', 3600, 'NX');
    if (!fresh || !first) {
      count(fresh ? 'line:reply_reused' : 'line:reply_expired');
      return json(400, { message: 'Invalid reply token' });
    }
    count('line:reply');
    return json(200, {});
  }
  if (route === '/v2/bot/message/push') {
    const retryKey = init.headers?.['X-Line-Retry-Key'];
    if (retryKey) {
      const first = await redis.set(`load:retry:${retryKey}`, '1', 'EX', 86400, 'NX');
      if (!first) {
        count('line:push_duplicate');
        return json(409, { message: 'duplicate' }, { 'x-line-accepted-request-id': randomUUID() });
      }
    }
    count('line:push');
    return json(200, { sentMessages: [{ id: randomUUID() }] });
  }
  if (route.startsWith('/v2/bot/profile/')) {
    count('line:profile');
    const userId = decodeURIComponent(route.split('/').pop());
    return json(200, { userId, displayName: `Load ${userId.slice(-6)}` });
  }
  if (route === '/v2/bot/chat/loading/start') {
    count('line:loading');
    return json(202, {});
  }
  if (route.endsWith('/content')) {
    count('line:content');
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  count('line:other');
  return json(200, {});
}

// ---------------------------------------------------------------- fake AI
const tokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 3));

/** Smallest value that satisfies a JSON schema, preferring "answer" choices. */
function fromSchema(schema, key, prompt) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out = {};
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        if (schema.required?.includes(name)) out[name] = fromSchema(child, name, prompt);
      }
      return out;
    }
    case 'array':
      if (key === 'evidenceIds') {
        const ref = /"ref"\s*:\s*"([^"]+)"/.exec(prompt)?.[1];
        return ref ? [ref] : [];
      }
      return schema.minItems ? [fromSchema(schema.items, key, prompt)] : [];
    case 'boolean':
      return true;
    case 'number':
    case 'integer':
      return schema.minimum ?? 1;
    case 'string':
      if (/answer/i.test(key ?? '')) return 'คำตอบทดสอบโหลดจากระบบจำลอง';
      return schema.minLength ? 'x'.repeat(schema.minLength) : 'load';
    default:
      return null;
  }
}

async function fakeGenerate(request) {
  const prompt = [
    request.systemInstruction ?? '',
    ...request.messages.map((m) => m.text ?? ''),
  ].join('\n');
  let text;
  let kind;
  if (request.responseJsonSchema) {
    kind = 'structured';
    text = JSON.stringify(fromSchema(request.responseJsonSchema, undefined, prompt));
  } else if (request.systemInstruction === CLASSIFIER_INSTRUCTION) {
    // GENERAL → answered by AI; BUSINESS with no evidence → contact-admin fallback.
    kind = 'classifier';
    const general = Math.random() < Number(process.env.LOAD_CLASSIFIER_GENERAL_RATE ?? 1);
    text = JSON.stringify({ classification: general ? 'GENERAL' : 'BUSINESS', confidence: 0.9 });
  } else {
    kind = 'text';
    text = 'คำตอบทดสอบโหลดจากระบบจำลอง';
  }
  await sleep(
    kind === 'text'
      ? latency('LOAD_AI_ANSWER_MS', '1500-4000')
      : latency('LOAD_AI_STRUCTURED_MS', '400-1200'),
  );
  if (Math.random() < Number(process.env.LOAD_AI_ERROR_RATE ?? 0)) {
    count('ai:generate_error');
    throw Object.assign(new Error('fake provider 503'), { status: 503 });
  }
  count('ai:generate');
  count(`ai:generate:${kind}`);
  return {
    text,
    provider: this.name,
    model: request.model,
    usage: {
      inputTokens: tokens(prompt),
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: tokens(text),
    },
    providerRequestId: `load-${randomUUID()}`,
  };
}

async function fakeEmbed(request) {
  await sleep(latency('LOAD_AI_EMBED_MS', '120-300'));
  count('ai:embed');
  const seed = createHash('sha256').update(request.text).digest();
  const values = Array.from({ length: 1536 }, (_, i) => seed[i % seed.length] / 255 - 0.5);
  return {
    values,
    model: this.model,
    usage: { inputTokens: tokens(request.text), cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    usageEstimated: false,
  };
}

const load = (rel) => require(path.join(dist, 'src', rel));
const CLASSIFIER_INSTRUCTION = load(
  'modules/chatbot/shared/prompt/low-confidence-classifier.prompt.js',
).LOW_CONFIDENCE_CLASSIFIER_SYSTEM_INSTRUCTION;
for (const [file, name] of [
  ['ai-provider/providers/gemini-ai.provider.js', 'GeminiAiProvider'],
  ['ai-provider/providers/openrouter-ai.provider.js', 'OpenRouterProvider'],
]) {
  const Provider = load(file)[name];
  Provider.prototype.isConfigured = () => true;
  Provider.prototype.generate = fakeGenerate;
}
load('infra/embedding/gemini-embedding.adapter.js').GeminiEmbeddingAdapter.prototype.embed = fakeEmbed;

// Measures what DEBUG logging costs: the app has no log-level setting yet.
if (process.env.LOAD_SUPPRESS_DEBUG === '1') {
  const { ConsoleLogger } = require(require.resolve('@nestjs/common', { paths: [process.cwd()] }));
  ConsoleLogger.prototype.debug = () => undefined;
  ConsoleLogger.prototype.verbose = () => undefined;
}

console.log('[load] fake LINE + AI installed; external network blocked');
