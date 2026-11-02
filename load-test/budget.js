// Budget-capped step test: how many concurrent chat users still get a reply
// in about 1 second?
//
//   k6 run -e BASE_URL=https://api.keela-agent.online load-test/budget.js
//
// Runs a 5-message smoke, then steps of 5 → 10 → 15 → 20 VUs. Each VU keeps
// ONE guest session for the whole run (≤ 20 sessions; the server allows 30 new
// sessions per IP per hour) and has a fixed message quota per step, so the
// total can never exceed MAX_MESSAGES no matter how fast the server answers.
// Total wall time is about 10 minutes.
//
// Safety for production:
// - The App Message API allows 30 messages/min per client IP (APP_MSG_PER_IP_MIN)
//   and adds ban strikes to an IP that keeps hitting the limit. RATE_PER_MIN
//   (default 25) paces every step below that limit. Raise it only after
//   raising APP_MSG_PER_IP_MIN on the server.
// - The first 429 (rate limited / banned) aborts the whole test.
// - Don't run it twice within an hour from the same IP (session budget).
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

// --- Plan: fixed message quota per VU per step, total ≤ MAX_MESSAGES -------
//
// One ramping-vus scenario, so VU 1..N keep their identity across steps and
// each creates exactly one guest session for the whole run. (The server allows
// only APP_SESSION_CREATE_PER_IP_HOUR = 30 new sessions per IP per hour.)

const SMOKE_SEC = 40;
const stepBudget = Math.floor((MAX_MESSAGES - SMOKE_MESSAGES) / STEPS.length);
const perStepByRate = Math.floor((RATE_PER_MIN * STEP_SEC) / 60);
const plan = [{ name: 'smoke', vus: 1, start: 0, sec: SMOKE_SEC, quota: SMOKE_MESSAGES, thinkSec: 1 }];
STEPS.forEach((vus, i) => {
  const quota = Math.max(1, Math.floor(Math.min(stepBudget, perStepByRate) / vus));
  plan.push({
    name: `vu${String(vus).padStart(2, '0')}`,
    vus,
    start: SMOKE_SEC + i * STEP_SEC,
    sec: STEP_SEC,
    quota, // messages per VU in this step
    // Spread a VU's quota over the step.
    thinkSec: STEP_SEC / quota,
  });
});
const plannedTotal = plan.reduce((n, s) => n + s.vus * s.quota, 0);
if (plannedTotal > MAX_MESSAGES) {
  throw new Error(`Planned ${plannedTotal} messages exceeds MAX_MESSAGES=${MAX_MESSAGES}`);
}
const MAX_VUS = Math.max(...plan.map((s) => s.vus));
const TOTAL_SEC = SMOKE_SEC + STEPS.length * STEP_SEC;

const stages = [];
for (const s of plan) {
  stages.push({ duration: '1s', target: s.vus });
  stages.push({ duration: `${s.sec - 1}s`, target: s.vus });
}

const thresholds = {
  chat_messages_sent: [`count<=${MAX_MESSAGES}`],
};
// Registers per-step sub-metrics so they appear in the summary.
for (const s of plan) {
  thresholds[`chat_reply_ms{step:${s.name}}`] = [`p(95)<${TARGET_MS}`];
  thresholds[`chat_ok{step:${s.name}}`] = ['rate>0.99'];
}

export const options = {
  scenarios: {
    chat: {
      executor: 'ramping-vus',
      exec: 'chat',
      startVUs: 0,
      stages,
      gracefulRampDown: '0s',
      gracefulStop: '60s',
    },
  },
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

/** The step the run is in right now, from time since the scenario started. */
function currentStep() {
  const sec = (Date.now() - exec.scenario.startTime) / 1000;
  for (let i = plan.length - 1; i >= 0; i--) if (sec >= plan[i].start) return plan[i];
  return plan[0];
}

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
    `target=${BASE_URL} planned_messages<=${plannedTotal} (cap ${MAX_MESSAGES}) sessions=${MAX_VUS} ` +
      `rate=${RATE_PER_MIN}/min duration=${TOTAL_SEC}s ` +
      plan.map((s) => `${s.name}:${s.vus}VUx${s.quota}msg`).join(' '),
  );
}

// --- One iteration = one chat message --------------------------------------

let token = null; // per VU, one session for the whole run
const sentInStep = {}; // per VU: step name -> messages sent

export function chat() {
  const step = currentStep();
  const done = sentInStep[step.name] || 0;
  if (done === 0 && step.name !== 'smoke') {
    // Stagger first messages so a new step does not fire all VUs at once.
    sleep(Math.random() * Math.min(step.thinkSec, 20));
  }
  if (done >= step.quota) {
    // Quota for this step used up: idle until the next step starts.
    const left = step.start + step.sec - (Date.now() - exec.scenario.startTime) / 1000;
    sleep(Math.max(1, Math.min(left, 10)));
    return;
  }

  if (!token) {
    const res = http.post(
      `${BASE_URL}/api/app/v1/sessions`,
      JSON.stringify({ displayName: `k6-budget-${exec.vu.idInTest}` }),
      { headers: json, tags: { step: step.name } },
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

  const tags = { step: step.name };
  sentInStep[step.name] = done + 1;
  const res = http.post(
    `${BASE_URL}/api/app/v1/messages`,
    JSON.stringify({ clientMessageId: uuidv4(), text: `${pick(QUESTIONS)}${pick(['', ' 🙏', '?'])}` }),
    { headers: Object.assign({ Authorization: `Bearer ${token}` }, json), timeout: '60s', tags },
  );
  sent.add(1, tags);
  stopOn429(res, 'send message');
  if (res.status === 401) {
    // Never create a replacement session: that spends the per-IP session budget.
    exec.test.abort('Guest session became invalid (401).');
  }

  const b = body(res);
  const good = check(
    res,
    {
      'reply 200': (r) => r.status === 200,
      'has meta.status': () => Boolean(b && b.meta && b.meta.status),
    },
    tags,
  );
  ok.add(good, tags);
  if (good) replyMs.add(res.timings.duration, tags);

  // Spread a VU's messages over the step (±30% so VUs do not sync up).
  sleep(Math.max(0.5, step.thinkSec - res.timings.duration / 1000) * (0.7 + Math.random() * 0.6));
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
  for (const { name } of plan) {
    const t = m[`chat_reply_ms{step:${name}}`];
    const r = m[`chat_ok{step:${name}}`];
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
