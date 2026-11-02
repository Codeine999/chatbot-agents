// Budget-capped step test: how many concurrent chat users still get a reply
// in about 1 second?
//
//   k6 run -e BASE_URL=https://api.keela-agent.online load-test/budget.js
//
// Runs a 5-message smoke, then steps of 5 → 10 → 15 → 20 VUs (one guest
// session each). Every iteration sends exactly ONE chat message, and every
// step has a fixed iteration count, so the total can never exceed
// MAX_MESSAGES no matter how fast the server answers. Total wall time is
// capped at about 10 minutes.
//
// Safety for production:
// - The App Message API allows 30 messages/min per client IP (APP_MSG_PER_IP_MIN)
//   and adds ban strikes to an IP that keeps hitting the limit. RATE_PER_MIN
//   (default 25) paces every step below that limit. Raise it only after
//   raising APP_MSG_PER_IP_MIN on the server.
// - The first 429 (rate limited / banned) aborts the whole test.
// - The LINE webhook is never called.

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
/** Hard cap on chat messages for the whole run, smoke included. */
const MAX_MESSAGES = Number(__ENV.MAX_MESSAGES || 1300);
/** Messages per minute across all VUs. Must stay under the server's per-IP limit. */
const RATE_PER_MIN = Number(__ENV.RATE_PER_MIN || 25);
/** Reply-time target for "fast enough". */
const TARGET_MS = Number(__ENV.TARGET_MS || 1000);
const STEPS = (__ENV.STEPS || '5,10,15,20').split(',').map(Number);
const STEP_SEC = Number(__ENV.STEP_SEC || 140);
const SMOKE_MESSAGES = 5;

// --- Plan: fixed message count per step, total ≤ MAX_MESSAGES -------------

const stepBudget = Math.floor((MAX_MESSAGES - SMOKE_MESSAGES) / STEPS.length);
const perStepByRate = Math.floor((RATE_PER_MIN * STEP_SEC) / 60);
const plan = STEPS.map((vus) => {
  const messages = Math.max(vus, Math.min(stepBudget, perStepByRate));
  // Each VU waits this long between its own messages so the step as a whole
  // sends about `messages` in STEP_SEC.
  const thinkSec = (vus * STEP_SEC) / messages;
  return { vus, messages, thinkSec };
});
const plannedTotal = SMOKE_MESSAGES + plan.reduce((n, s) => n + s.messages, 0);
if (plannedTotal > MAX_MESSAGES) {
  throw new Error(`Planned ${plannedTotal} messages exceeds MAX_MESSAGES=${MAX_MESSAGES}`);
}

const SMOKE_SEC = 40;
const scenarios = {
  smoke: {
    executor: 'shared-iterations',
    exec: 'chat',
    vus: 1,
    iterations: SMOKE_MESSAGES,
    maxDuration: `${SMOKE_SEC}s`,
    env: { THINK: '1' },
  },
};
plan.forEach((s, i) => {
  scenarios[`vu${String(s.vus).padStart(2, '0')}`] = {
    executor: 'shared-iterations',
    exec: 'chat',
    vus: s.vus,
    iterations: s.messages,
    startTime: `${SMOKE_SEC + i * STEP_SEC}s`,
    maxDuration: `${STEP_SEC}s`,
    env: { THINK: String(s.thinkSec) },
  };
});

const thresholds = {
  // Registers per-step sub-metrics so they appear in the summary.
  chat_messages_sent: [`count<=${MAX_MESSAGES}`],
};
for (const name of Object.keys(scenarios)) {
  thresholds[`chat_reply_ms{scenario:${name}}`] = [`p(95)<${TARGET_MS}`];
  thresholds[`chat_ok{scenario:${name}}`] = ['rate>0.99'];
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// --- Metrics ---------------------------------------------------------------

const sent = new Counter('chat_messages_sent');
const replyMs = new Trend('chat_reply_ms', true);
const ok = new Rate('chat_ok');

const QUESTIONS = [
  'สวัสดีครับ',
  'ร้านเปิดกี่โมงคะ',
  'ส่งของกี่วันถึงครับ',
  'ค่าส่งเท่าไหร่คะ',
  'มีบริการเก็บเงินปลายทางไหมครับ',
  'มีโปรโมชั่นอะไรบ้างตอนนี้',
  'ชำระเงินช่องทางไหนได้บ้างคะ',
  'ติดตามพัสดุยังไงครับ',
  'สินค้ามีรับประกันไหมคะ',
  'ขอเบอร์ติดต่อร้านหน่อยครับ',
  'ขอดูสินค้าขายดีหน่อยค่ะ',
  'ขอบคุณครับ',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const json = { 'Content-Type': 'application/json', Accept: 'application/json' };
const body = (res) => {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
};

function stopOn429(res, what) {
  if (res.status === 429) {
    const b = body(res);
    exec.test.abort(
      `${what} got 429 ${b && b.code} (rate limited). Stopped to avoid an IP ban. ` +
        'Lower RATE_PER_MIN or raise APP_MSG_PER_IP_MIN on the server.',
    );
  }
}

export function setup() {
  const res = http.get(`${BASE_URL}/`);
  if (res.status === 0) fail(`Cannot reach ${BASE_URL}: ${res.error}`);
  console.log(
    `target=${BASE_URL} planned_messages=${plannedTotal} (cap ${MAX_MESSAGES}) rate=${RATE_PER_MIN}/min ` +
      plan.map((s) => `${s.vus}VU:${s.messages}msg/think${s.thinkSec.toFixed(1)}s`).join(' '),
  );
}

// --- One iteration = one chat message --------------------------------------

let token = null; // per VU; reused across steps
let currentStep = null;

export function chat() {
  const think = Number(__ENV.THINK || 1);
  // Stagger each VU's first message in a step so a new step does not fire
  // all its VUs at once and trip the per-minute limit.
  if (currentStep !== exec.scenario.name) {
    currentStep = exec.scenario.name;
    if (currentStep !== 'smoke') sleep(Math.random() * think);
  }

  if (!token) {
    const res = http.post(
      `${BASE_URL}/api/app/v1/sessions`,
      JSON.stringify({ displayName: `k6-budget-${exec.vu.idInTest}` }),
      { headers: json },
    );
    stopOn429(res, 'create session');
    if (res.status === 404) {
      exec.test.abort('App Message API is off on the server (404): set APP_MESSAGE_ENABLED=true.');
    }
    const b = body(res);
    if (res.status !== 201 || !b || !b.sessionToken) {
      exec.test.abort(`Cannot create a guest session (status ${res.status}).`);
    }
    token = b.sessionToken;
  }

  const res = http.post(
    `${BASE_URL}/api/app/v1/messages`,
    JSON.stringify({ clientMessageId: uuidv4(), text: `${pick(QUESTIONS)}${pick(['', ' 🙏', '?'])}` }),
    { headers: Object.assign({ Authorization: `Bearer ${token}` }, json), timeout: '60s' },
  );
  sent.add(1);
  stopOn429(res, 'send message');
  if (res.status === 401) token = null;

  const b = body(res);
  const good = check(res, {
    'reply 200': (r) => r.status === 200,
    'has meta.status': () => Boolean(b && b.meta && b.meta.status),
  });
  ok.add(good);
  if (good) replyMs.add(res.timings.duration);

  // Spread a VU's messages over the step (±30% so VUs do not sync up).
  sleep(Math.max(0.5, think - res.timings.duration / 1000) * (0.7 + Math.random() * 0.6));
}

// --- Short per-step report -------------------------------------------------

export function handleSummary(data) {
  const m = data.metrics;
  const fmt = (v) => (v === undefined ? '-' : `${Math.round(v)}ms`);
  const lines = [
    '',
    `Target: ${BASE_URL}   reply target p95 < ${TARGET_MS}ms`,
    `Messages actually sent: ${m.chat_messages_sent ? m.chat_messages_sent.values.count : 0} (cap ${MAX_MESSAGES})`,
    '',
    'step    msgs   ok%     p50      p95      max     <= target?',
  ];
  for (const name of Object.keys(scenarios)) {
    const t = m[`chat_reply_ms{scenario:${name}}`];
    const r = m[`chat_ok{scenario:${name}}`];
    const n = r ? r.values.passes + r.values.fails : 0;
    const p95 = t && t.values['p(95)'];
    lines.push(
      [
        name.padEnd(7),
        String(n).padStart(4),
        (r && n ? `${(r.values.rate * 100).toFixed(1)}%` : '-').padStart(7),
        fmt(t && t.values.med).padStart(8),
        fmt(p95).padStart(8),
        fmt(t && t.values.max).padStart(8),
        n === 0 ? '   (not run)' : p95 !== undefined && p95 < TARGET_MS && r.values.rate > 0.99 ? '   yes' : '   NO',
      ].join(' '),
    );
  }
  lines.push('');
  return {
    stdout: lines.join('\n'),
    'budget-summary.json': JSON.stringify(data, null, 2),
  };
}
