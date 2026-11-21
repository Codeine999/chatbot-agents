// Live audit runner for the Product RAG (transport) flow through the App REST channel.
// Real LLM calls are billed: a hard cap (default 100 chat calls) is enforced before EVERY message.
//
//   node test/scripts/run-transport-live.mjs <outDir> [--cases=file] [--only=P01,P02] [--max=N] [--dry]
//
// Needs: server on :8080 with APP_MESSAGE_ENABLED, docker container nest-postgres.
// Each conversation gets its own guest session and its own loopback source address
// (127.0.<n>.1) so the per-IP session limit (30/hour) does not turn a 80-message
// audit into a rate-limit test. Messages are paced; 429 Retry-After is honoured.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const casesFile = opt('cases', 'test/audit/transport-live.cases.json');
const only = opt('only', '')?.split(',').filter(Boolean);
const maxCases = Number(opt('max', '1000'));
const dry = args.includes('--dry');
const BUDGET = Number(process.env.AUDIT_LLM_BUDGET ?? 100);
const BASE = { host: '127.0.0.1', port: 8080 };
const ORIGIN = 'http://localhost:5173';
if (!outDir) throw new Error('outDir required');
mkdirSync(outDir, { recursive: true });

// ---------- DB helpers ----------
function psql(sql) {
  const r = spawnSync('docker', ['exec', 'nest-postgres', 'psql', '-U', 'chatbot', '-d', 'app_db', '-At', '-c', sql], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}
const esc = (s) => String(s).replaceAll("'", "''");
const rows = (sql) => {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`);
  return JSON.parse(out || '[]');
};
function counters() {
  const reservation = rows(`select
    count(*) filter (where "operationKey" like 'usage:%' and "operationKey" not like 'usage:embed:%')::int as chat,
    count(*) filter (where "operationKey" like 'usage:embed:%')::int as embed
    from "creditReservation"`)[0];
  const events = rows(`select
    count(*) filter (where kind = 'LINE_AI_REPLY')::int as chat,
    count(*) filter (where kind = 'EMBEDDING')::int as embed
    from "aiUsageEvents"`)[0];
  return { reservation, events };
}
const chatOf = (c) => Math.max(c.reservation.chat, c.events.chat);
const embedOf = (c) => Math.max(c.reservation.embed, c.events.embed);

// ---------- HTTP ----------
function request(method, path, { token, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      ...BASE, method, path, localAddress,
      headers: {
        origin: ORIGIN,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout 120s')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = new Map(); // conversation -> { token, ip }
let ipCounter = 0;
async function sessionFor(conversation) {
  if (sessions.has(conversation)) return sessions.get(conversation);
  ipCounter += 1;
  const ip = `127.0.${ipCounter % 250}.1`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await request('POST', '/api/app/v1/sessions', { body: { displayName: `audit-${conversation}` }, localAddress: ip });
    if (res.status === 201) {
      const s = { token: res.json.sessionToken, ip, guestId: res.json.guestId };
      sessions.set(conversation, s);
      return s;
    }
    if (res.status === 429) { await sleep((Number(res.headers['retry-after']) || 5) * 1000 + 500); continue; }
    throw new Error(`session create failed ${res.status} ${res.text.slice(0, 200)}`);
  }
  throw new Error('session create: rate limited repeatedly');
}

async function send(sess, text) {
  const clientMessageId = randomUUID();
  let retries429 = 0; let retries5xx = 0;
  for (;;) {
    const res = await request('POST', '/api/app/v1/messages', { token: sess.token, body: { clientMessageId, text }, localAddress: sess.ip });
    if (res.status === 429 && retries429 < 6) {
      retries429++;
      await sleep((Number(res.headers['retry-after']) || 5) * 1000 + 500);
      continue;
    }
    if (res.status >= 500 && retries5xx < 2) { retries5xx++; await sleep(3000); continue; }
    return { clientMessageId, res, retries429, retries5xx };
  }
}

// ---------- evidence ----------
async function evidence(inboundId) {
  const eventId = `app:${inboundId}`;
  let dl;
  for (let i = 0; i < 20; i++) {
    dl = rows(`select * from "decisionLogs" where "eventId" = '${esc(eventId)}'`)[0];
    if (dl) break;
    await sleep(500);
  }
  const ct = rows(`select id, "connectionKey", "externalEventId", provider, model, input, plan, retrieval, response, "createdAt", "updatedAt"
    from "commerceTurns" where "externalEventId" = '${esc(eventId)}'`)[0];
  const calls = ct ? rows(`select slot, ordinal, failed, request, result, "createdAt" from "commerceLlmCalls" where "turnId" = '${ct.id}' order by ordinal`) : [];
  return { eventId, dl, ct, calls };
}

function observedFlow(dl, ct) {
  if (!dl) return { flow: 'UNKNOWN', why: 'no decisionLogs row' };
  const type = dl.answerType;
  const planMode = ct?.plan?.mode ?? null;
  if (type === 'PRODUCT') return { flow: 'PRODUCT', why: `answerType=PRODUCT plan.mode=${planMode}` };
  if (dl.isFallback || type === 'HANDOFF') return { flow: 'FALLBACK', why: `answerType=${type} isFallback=${dl.isFallback} reason=${dl.fallbackReason}` };
  if (type === 'GENERAL') return { flow: 'GENERAL', why: 'answerType=GENERAL' };
  if (['KNOWLEDGE', 'MICRO_KNOWLEDGE', 'MIXED_KNOWLEDGE'].includes(type)) return { flow: 'KNOWLEDGE', why: `answerType=${type}` };
  return { flow: 'RULE', why: `answerType=${type}` };
}

function judge(c, obs, reply, dl, handoff) {
  const allowed = [c.expect.flow, ...(c.expect.alt ?? [])];
  const flowOk = allowed.includes(obs.flow);
  const productFallback = obs.flow === 'PRODUCT' && !!dl?.isFallback;
  const handoffBad = !!c.expect.noHandoff && (!!dl?.isFallback || !!dl?.handoffRequested || handoff);
  const must = (c.expect.mustMatch ?? []).map((r) => ({ re: r, ok: new RegExp(r, 'u').test(reply) }));
  const not = (c.expect.mustNotMatch ?? []).map((r) => ({ re: r, hit: new RegExp(r, 'u').test(reply) }));
  const mustOk = must.every((m) => m.ok);
  const notOk = not.every((m) => !m.hit);
  return {
    flowOk, handoffBad, mustOk, notOk, productFallback,
    mustFailed: must.filter((m) => !m.ok).map((m) => m.re),
    notHit: not.filter((m) => m.hit).map((m) => m.re),
    auto: flowOk && !handoffBad && mustOk && notOk ? 'PASS' : 'FAIL',
  };
}

// ---------- main ----------
const allCases = JSON.parse(readFileSync(casesFile, 'utf8'));
writeFileSync(`${outDir}/cases.json`, JSON.stringify(allCases, null, 2));
let todo = only?.length ? allCases.filter((c) => only.includes(c.id)) : allCases;
todo = todo.slice(0, maxCases);

const resultsPath = `${outDir}/results.json`;
const previous = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : null;
const startCounters = counters();
const baseline = previous?.budget?.baseline ?? { chat: chatOf(startCounters), embed: embedOf(startCounters), raw: startCounters, at: new Date().toISOString() };
const out = previous ?? { budget: { cap: BUDGET, baseline, final: null }, results: [], notRun: [] };
const done = new Set(out.results.map((r) => r.id));
console.log(`baseline chat=${baseline.chat} embed=${baseline.embed} cap=${BUDGET} cases=${todo.length}`);
if (dry) { console.log(JSON.stringify(startCounters)); process.exit(0); }

const save = () => writeFileSync(resultsPath, JSON.stringify(out, null, 2));
let stopped = null;
for (const c of todo) {
  if (done.has(c.id)) continue;
  const now = counters();
  const used = chatOf(now) - baseline.chat;
  const worst = c.expect.flow === 'PRODUCT' ? 3 : 2;
  if (used >= BUDGET || used + worst > BUDGET) {
    stopped = { at: c.id, used, worst, reason: 'LLM budget guard' };
    break;
  }
  const t0 = Date.now();
  const before = counters();
  let sess;
  try { sess = await sessionFor(c.conversation); } catch (e) {
    out.results.push({ id: c.id, error: `session: ${e.message}` }); save(); continue;
  }
  let sent;
  try { sent = await send(sess, c.text); } catch (e) {
    out.results.push({ id: c.id, text: c.text, error: `send: ${e.message}` }); save(); continue;
  }
  const latencyMs = Date.now() - t0;
  const body = sent.res.json;
  const rec = {
    id: c.id, group: c.group, conversation: c.conversation, turn: c.turn, text: c.text,
    expect: c.expect, httpStatus: sent.res.status, retries429: sent.retries429, retries5xx: sent.retries5xx,
    clientMessageId: sent.clientMessageId, sessionGuestId: sess.guestId, latencyMs,
  };
  if (sent.res.status !== 200 || !body?.message) {
    rec.error = `HTTP ${sent.res.status} ${sent.res.text.slice(0, 300)}`;
    rec.auto = 'FAIL';
  } else {
    const inboundId = body.message.id;
    const ev = await evidence(inboundId);
    const after = counters();
    const reply = (body.replies ?? []).map((r) => r.text).join('\n');
    const obs = observedFlow(ev.dl, ev.ct);
    rec.messageId = inboundId;
    rec.turnId = ev.eventId;
    rec.reply = reply;
    rec.meta = body.meta;
    rec.observed = obs;
    rec.signals = ev.dl && {
      answerType: ev.dl.answerType, answerMode: ev.dl.answerMode, action: ev.dl.action, intent: ev.dl.intent,
      routeSource: ev.dl.routeSource, routeReason: ev.dl.routeReason, retrievalRoute: ev.dl.retrievalRoute,
      retrievalFallbackReason: ev.dl.retrievalFallbackReason, isFallback: ev.dl.isFallback, fallbackReason: ev.dl.fallbackReason,
      handoffRequested: ev.dl.handoffRequested, responseSource: ev.dl.responseSource, contextPolicy: ev.dl.contextPolicy,
      llmCallCount: ev.dl.llmCallCount, llmInputTokens: ev.dl.llmInputTokens, llmOutputTokens: ev.dl.llmOutputTokens,
      dlLatencyMs: ev.dl.latencyMs, candidateCount: ev.dl.candidateCount, candidates: ev.dl.candidates,
      retrievalQuery: ev.dl.retrievalQuery, commerceTurnId: ev.dl.commerceTurnId,
    };
    rec.trace = ev.dl?.trace;
    rec.commerceTurn = ev.ct && {
      id: ev.ct.id, connectionKey: ev.ct.connectionKey, model: ev.ct.model, input: ev.ct.input,
      plan: ev.ct.plan, retrieval: ev.ct.retrieval, response: ev.ct.response,
    };
    rec.commerceLlmCalls = ev.calls;
    rec.productFlowEntered = !!ev.ct;
    rec.planMode = ev.ct?.plan?.mode ?? null;
    rec.budgetDelta = {
      chatReservations: after.reservation.chat - before.reservation.chat,
      chatEvents: after.events.chat - before.events.chat,
      embedReservations: after.reservation.embed - before.reservation.embed,
      embedEvents: after.events.embed - before.events.embed,
    };
    rec.verdict = judge(c, obs, reply, ev.dl, !!body.meta?.handoff);
    rec.auto = rec.verdict.auto;
  }
  out.results.push(rec);
  save();
  const u = chatOf(counters()) - baseline.chat;
  console.log(`${c.id.padEnd(4)} ${rec.auto?.padEnd(4)} exp=${c.expect.flow.padEnd(9)} obs=${(rec.observed?.flow ?? '-').padEnd(9)} llm=${rec.signals?.llmCallCount ?? '-'} used=${u}/${BUDGET} ${latencyMs}ms | ${c.text} -> ${(rec.reply ?? rec.error ?? '').replace(/\n/g, ' / ').slice(0, 110)}`);
  await sleep(1200);
}
const doneIds = new Set(out.results.map((r) => r.id));
out.notRun = allCases.filter((c) => !doneIds.has(c.id) && (!only?.length || only.includes(c.id))).map((c) => c.id);
const fin = counters();
out.budget.final = { chat: chatOf(fin), embed: embedOf(fin), usedChat: chatOf(fin) - baseline.chat, usedEmbed: embedOf(fin) - baseline.embed, raw: fin, at: new Date().toISOString() };
out.stopped = stopped;
save();
console.log(`finished: chat used ${out.budget.final.usedChat}/${BUDGET}, embed used ${out.budget.final.usedEmbed}, notRun=${out.notRun.length}${stopped ? ' STOPPED ' + JSON.stringify(stopped) : ''}`);
