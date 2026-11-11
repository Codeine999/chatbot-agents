// k6 load test for the chatbot backend.
//
//   k6 run -e BASE_URL=https://staging.example.com -e PROFILE=smoke load-test/load.js
//
// Scenarios:
//   chat  – guests on the App Message API (/api/app/v1): create a session once
//           per VU, then send questions with think time. Every message runs the
//           real chatbot pipeline (intent → RAG → AI) and is charged to the
//           company wallet, exactly like LINE traffic.
//   admin – back-office dashboard reads (only when ADMIN_TOKEN or
//           ADMIN_USERNAME/ADMIN_PASSWORD is given). No AI calls.
//
// The LINE webhook is deliberately not tested: it replies through the real
// LINE API, so a load test would message real customers.
//
// See load-test/README.md for profiles, required server settings and how to
// read the results.

import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

// ---------------------------------------------------------------------------
// Configuration (all via -e NAME=value)
// ---------------------------------------------------------------------------

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PROFILE = (__ENV.PROFILE || 'smoke').toLowerCase();

// Admin dashboard scenario (optional).
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const ADMIN_ENABLED = Boolean(ADMIN_TOKEN || (ADMIN_USERNAME && ADMIN_PASSWORD));
/** Admin VUs as a share of chat VUs (admins are far fewer than customers). */
const ADMIN_RATIO = Number(__ENV.ADMIN_RATIO || 0.05);

// Think time between customer messages, in seconds (people read and type).
const THINK_MIN = Number(__ENV.THINK_MIN || 3);
const THINK_MAX = Number(__ENV.THINK_MAX || 10);

// Thresholds. The chat send waits for the AI answer, so it gets its own budget.
const CHAT_P95_MS = Number(__ENV.CHAT_P95_MS || 8000);
const API_P95_MS = Number(__ENV.API_P95_MS || 500);
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);

// Every VU comes from the same machine, so the per-IP limits (30 msg/min,
// 30 sessions/hour, 50 active sessions per IP) would throttle the whole test
// as one user. With SPOOF_IP=1 each VU sends its own X-Forwarded-For. This
// only works when k6 reaches the app directly (no nginx rewriting the header)
// and the app runs with TRUST_PROXY_HOPS=1. Staging only.
const SPOOF_IP = __ENV.SPOOF_IP === '1' || __ENV.SPOOF_IP === 'true';

/** Multiplies every VU target, e.g. SCALE=0.5 for a half-size run. */
const SCALE = Number(__ENV.SCALE || 1);

// ---------------------------------------------------------------------------
// Load profiles
// ---------------------------------------------------------------------------

const PROFILES = {
  // Sanity check: does every request work at all?
  smoke: [
    { duration: '30s', target: 2 },
    { duration: '1m', target: 2 },
    { duration: '10s', target: 0 },
  ],
  // Expected busy hour: 50 → 200 → 400 concurrent customers, hold at each.
  load: [
    { duration: '2m', target: 50 },
    { duration: '3m', target: 50 },
    { duration: '2m', target: 200 },
    { duration: '5m', target: 200 },
    { duration: '2m', target: 400 },
    { duration: '5m', target: 400 },
    { duration: '2m', target: 0 },
  ],
  // Keep climbing past the expected peak to find where it breaks.
  stress: [
    { duration: '2m', target: 100 },
    { duration: '3m', target: 200 },
    { duration: '3m', target: 400 },
    { duration: '3m', target: 600 },
    { duration: '3m', target: 800 },
    { duration: '3m', target: 1000 },
    { duration: '3m', target: 0 },
  ],
  // Sudden burst (e.g. a broadcast message makes everyone reply at once).
  spike: [
    { duration: '1m', target: 20 },
    { duration: '30s', target: 400 },
    { duration: '3m', target: 400 },
    { duration: '30s', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  // Moderate load for a long time: leaks, queue build-up, connection pools.
  soak: [
    { duration: '5m', target: 100 },
    { duration: '1h', target: 100 },
    { duration: '5m', target: 0 },
  ],
};

if (!PROFILES[PROFILE]) {
  throw new Error(
    `Unknown PROFILE "${PROFILE}". Use one of: ${Object.keys(PROFILES).join(', ')}`,
  );
}

const scaleStages = (stages, factor, min = 0) =>
  stages.map((s) => ({
    duration: s.duration,
    target: s.target === 0 ? 0 : Math.max(min, Math.round(s.target * factor)),
  }));

const chatStages = scaleStages(PROFILES[PROFILE], SCALE, 1);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Time from sending a message to receiving the bot's answer. */
const chatAnswerDuration = new Trend('chat_answer_duration', true);
/** Share of messages the bot answered (vs NO_REPLY / handoff). */
const chatAnswered = new Rate('chat_answered');
/** 429s: our own rate limits, not server failure. Watch it separately. */
const rateLimited = new Counter('rate_limited');
/** 503 APP_UNAVAILABLE: the turn failed (AI/provider/DB). */
const turnUnavailable = new Counter('turn_unavailable');
/** 409 APP_CONVERSATION_BUSY: previous turn of the same guest still running. */
const conversationBusy = new Counter('conversation_busy');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const scenarios = {
  chat: {
    executor: 'ramping-vus',
    exec: 'chatScenario',
    startVUs: 0,
    stages: chatStages,
    gracefulRampDown: '30s',
    // A turn can legitimately take the full AI timeout; let it finish.
    gracefulStop: '60s',
  },
};

if (ADMIN_ENABLED) {
  scenarios.admin = {
    executor: 'ramping-vus',
    exec: 'adminScenario',
    startVUs: 0,
    stages: scaleStages(PROFILES[PROFILE], SCALE * ADMIN_RATIO, 1),
    gracefulRampDown: '10s',
  };
}

export const options = {
  scenarios,
  thresholds: {
    // Overall: fewer than 1% of requests fail (4xx/5xx other than expected).
    http_req_failed: [{ threshold: `rate<${MAX_ERROR_RATE}`, abortOnFail: false }],
    // Cheap endpoints (session, history, dashboard) must stay fast.
    'http_req_duration{kind:api}': [`p(95)<${API_P95_MS}`],
    // Chat turn includes retrieval + AI; judged on its own budget.
    'http_req_duration{kind:chat}': [`p(95)<${CHAT_P95_MS}`, `p(99)<${CHAT_P95_MS * 2}`],
    chat_answer_duration: [`p(95)<${CHAT_P95_MS}`],
    checks: ['rate>0.99'],
  },
  // Show p90/p95/p99 in the end-of-test summary.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// Typical customer questions. Mix of FAQ (should hit knowledge/answer
// patterns), product questions (RAG) and small talk. Edit to match your shop.
const QUESTIONS = [
  'สวัสดีครับ',
  'ร้านเปิดกี่โมงคะ',
  'ส่งของกี่วันถึงครับ',
  'ค่าส่งเท่าไหร่คะ',
  'มีบริการเก็บเงินปลายทางไหมครับ',
  'ขอดูสินค้าขายดีหน่อยค่ะ',
  'มีโปรโมชั่นอะไรบ้างตอนนี้',
  'สินค้านี้มีไซส์อะไรบ้างครับ',
  'เปลี่ยนสินค้าได้ไหมถ้าไซส์ไม่พอดี',
  'ชำระเงินช่องทางไหนได้บ้างคะ',
  'ติดตามพัสดุยังไงครับ',
  'สมัครสมาชิกยังไงคะ',
  'มีสินค้าราคาไม่เกิน 500 บาทไหม',
  'ขอเบอร์ติดต่อร้านหน่อยครับ',
  'สินค้ามีรับประกันไหมคะ',
  'ขอบคุณครับ',
  'How long does shipping take?',
  'Do you have any discounts right now?',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function think(min = THINK_MIN, max = THINK_MAX) {
  sleep(min + Math.random() * Math.max(0, max - min));
}

/** A stable fake client IP per VU (10.x.y.z), used only when SPOOF_IP=1. */
function vuIp() {
  const id = exec.vu.idInTest;
  return `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`;
}

function baseHeaders(extra) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (SPOOF_IP) headers['X-Forwarded-For'] = vuIp();
  return Object.assign(headers, extra || {});
}

function safeJson(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

/** Count our own error codes so a 429 storm is not mistaken for a crash. */
function classify(res) {
  if (res.status === 429) rateLimited.add(1);
  else if (res.status === 503) turnUnavailable.add(1);
  else if (res.status === 409) conversationBusy.add(1);
}

// ---------------------------------------------------------------------------
// Setup: verify the target and (optionally) log the admin in once.
// ---------------------------------------------------------------------------

export function setup() {
  const ping = http.get(`${BASE_URL}/`, { tags: { kind: 'api', name: 'GET /' } });
  if (ping.status === 0) {
    fail(`Cannot reach ${BASE_URL}: ${ping.error}`);
  }

  let adminToken = ADMIN_TOKEN;
  if (!adminToken && ADMIN_USERNAME && ADMIN_PASSWORD) {
    const res = http.post(
      `${BASE_URL}/api/admin/auth/login`,
      JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
      { headers: baseHeaders(), tags: { kind: 'api', name: 'POST /api/admin/auth/login' } },
    );
    const body = safeJson(res);
    if (res.status !== 200 || !body || !body.accessToken) {
      fail(`Admin login failed (status ${res.status})`);
    }
    adminToken = body.accessToken;
  }

  console.log(
    `target=${BASE_URL} profile=${PROFILE} scale=${SCALE} admin=${ADMIN_ENABLED} spoofIp=${SPOOF_IP}`,
  );
  return { adminToken };
}

// ---------------------------------------------------------------------------
// Chat scenario: one VU = one customer with their own guest session.
// ---------------------------------------------------------------------------

// Per-VU state (module scope is per VU in k6).
let sessionToken = null;

function createSession() {
  const res = http.post(
    `${BASE_URL}/api/app/v1/sessions`,
    JSON.stringify({ displayName: `k6-vu-${exec.vu.idInTest}` }),
    { headers: baseHeaders(), tags: { kind: 'api', name: 'POST /api/app/v1/sessions' } },
  );
  classify(res);
  const body = safeJson(res);
  const ok = check(res, {
    'session created (201)': (r) => r.status === 201,
    'session has token': () => Boolean(body && body.sessionToken),
  });
  if (!ok) {
    if (res.status === 404) {
      fail('App Message API is disabled (404). Set APP_MESSAGE_ENABLED=true on the target.');
    }
    return null;
  }
  return body.sessionToken;
}

export function chatScenario() {
  if (!sessionToken) {
    sessionToken = createSession();
    if (!sessionToken) {
      // Back off so a broken target is not hammered in a tight loop.
      sleep(5);
      return;
    }
    think(1, 3);
  }

  const auth = baseHeaders({ Authorization: `Bearer ${sessionToken}` });

  group('send message', () => {
    // A short random tail keeps identical questions from tripping the spam
    // detector (same text repeated) while staying realistic.
    const text = `${pick(QUESTIONS)}${pick(['', '', ' 🙏', ' 😊', '?'])}`;
    const res = http.post(
      `${BASE_URL}/api/app/v1/messages`,
      JSON.stringify({ clientMessageId: uuidv4(), text }),
      {
        headers: auth,
        tags: { kind: 'chat', name: 'POST /api/app/v1/messages' },
        timeout: '120s',
      },
    );
    classify(res);

    if (res.status === 401) {
      // Session expired or revoked: start a new one next iteration.
      sessionToken = null;
      return;
    }

    const body = safeJson(res);
    const ok = check(res, {
      'message 200': (r) => r.status === 200,
      'message has meta.status': () => Boolean(body && body.meta && body.meta.status),
    });
    if (ok) {
      chatAnswerDuration.add(res.timings.duration);
      chatAnswered.add(body.meta.status === 'ANSWERED');
    }
  });

  // Reading the reply before typing the next message.
  think();

  // Sometimes the client polls history (e.g. app reopened).
  if (Math.random() < 0.2) {
    group('read history', () => {
      const res = http.get(`${BASE_URL}/api/app/v1/messages?limit=30`, {
        headers: auth,
        tags: { kind: 'api', name: 'GET /api/app/v1/messages' },
      });
      classify(res);
      check(res, { 'history 200': (r) => r.status === 200 });
    });
    think(1, 3);
  }
}

// ---------------------------------------------------------------------------
// Admin scenario: back-office dashboard polling. Reads only, no AI.
// ---------------------------------------------------------------------------

const ADMIN_READS = [
  '/api/admin/notifications/unread-count',
  '/api/admin/notifications',
  '/api/admin/wallet/mine',
  '/api/admin/app-conversations',
  '/api/conversations',
  '/api/admin/knowledge-micro/count',
  '/api/admin/knowledge-patterns/count',
  '/api/admin/usage',
];

export function adminScenario(data) {
  const headers = baseHeaders({ Authorization: `Bearer ${data.adminToken}` });
  const path = pick(ADMIN_READS);
  const res = http.get(`${BASE_URL}${path}`, {
    headers,
    tags: { kind: 'api', name: `GET ${path}` },
  });
  classify(res);
  check(res, { 'admin read 200': (r) => r.status === 200 });
  // Dashboards poll every few seconds.
  think(2, 6);
}

// k6 requires a default export when no scenario names one; keep it harmless.
export default function () {
  chatScenario();
}
