// Sends LINE-shaped, correctly signed webhooks to the load app (open model:
// arrivals do not wait for replies). Every sent event is appended to
// <outDir>/manifest.jsonl for verify-load.mjs.
//
//   node test/load/generate-load.mjs --out <dir> --scenario steady --rps 30 --duration 600 --users 1000
//   scenarios: steady | burst (--users N at once) | same-user (--users N × --messages M)
//              | redelivery (steady + re-send --redeliver fraction of events)
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const out = args.out ?? 'load-results';
const scenario = args.scenario ?? 'steady';
const rps = Number(args.rps ?? 5);
const duration = Number(args.duration ?? 60);
const users = Number(args.users ?? 300);
const messages = Number(args.messages ?? 5);
const redeliver = Number(args.redeliver ?? 0.1);
const url = args.url ?? `http://127.0.0.1:${process.env.LOAD_PORT ?? 18090}/api/line/webhooks`;
const secret = process.env.LOAD_LINE_SECRET ?? 'load-secret';
const run = args.run ?? Date.now().toString(36);
mkdirSync(out, { recursive: true });
const manifest = `${out}/manifest.jsonl`;

const QUESTIONS = [
  'สินค้ามีอะไรบ้าง',
  'ราคาเท่าไหร่ครับ',
  'ส่งของกี่วันถึง',
  'มีโปรโมชั่นไหม',
  'เปิดกี่โมง',
  'สมัครสมาชิกยังไง',
  'จ่ายเงินช่องทางไหนได้บ้าง',
  'ขอเบอร์ติดต่อหน่อย',
  'สินค้าตัวนี้มีสีอะไรบ้าง',
  'รับประกันกี่ปี',
  'วันนี้อากาศเป็นยังไง',
  'แนะนำของขวัญให้แม่หน่อย',
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const userId = (n) => `Uload${run}${String(n).padStart(6, '0')}`;
const seqByUser = new Map();

function makeEvent(user) {
  const seq = (seqByUser.get(user) ?? 0) + 1;
  seqByUser.set(user, seq);
  const now = Date.now();
  const base = {
    webhookEventId: `ev-${run}-${user}-${seq}`,
    timestamp: now,
    source: { type: 'user', userId: userId(user) },
    mode: 'active',
    deliveryContext: { isRedelivery: false },
    replyToken: `rt.${now}.${randomUUID()}`,
  };
  const roll = Math.random();
  // Postbacks carry no LINE message id; sticker/text do.
  if (roll < 0.1) {
    return { ...base, type: 'postback', postback: { data: `action=load&seq=${seq}` } };
  }
  if (roll < 0.2) {
    return {
      ...base,
      type: 'message',
      message: { type: 'sticker', id: `m-${run}-${user}-${seq}`, packageId: '446', stickerId: '1988', keywords: ['Hello'] },
    };
  }
  return {
    ...base,
    type: 'message',
    // The suffix keeps repeated questions from tripping the same-text spam rule.
    message: { type: 'text', id: `m-${run}-${user}-${seq}`, text: `${pick(QUESTIONS)} (${seq})` },
  };
}

const stats = { sent: 0, ok: 0, rejected: {}, errors: 0, latencies: [] };

async function post(events, redelivery = false) {
  const body = JSON.stringify({ destination: 'Uloadbot', events });
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const started = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body,
    });
    status = res.status;
    await res.arrayBuffer();
  } catch {
    stats.errors += 1;
  }
  stats.latencies.push(Date.now() - started);
  stats.sent += events.length;
  if (status === 200) stats.ok += events.length;
  else stats.rejected[status] = (stats.rejected[status] ?? 0) + events.length;
  appendFileSync(
    manifest,
    events
      .map((e) =>
        JSON.stringify({
          id: e.webhookEventId,
          user: e.source.userId,
          seq: Number(e.webhookEventId.split('-').pop()),
          type: e.type === 'message' ? e.message.type : e.type,
          ts: e.timestamp,
          status,
          redelivery,
        }),
      )
      .join('\n') + '\n',
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inflight = new Set();
const fire = (promise) => {
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
};

async function steady() {
  // Round-robin users so each one stays under the per-user burst/hour limits.
  const started = Date.now();
  let next = 0;
  for (let i = 0; Date.now() - started < duration * 1000; i++) {
    const due = started + (i * 1000) / rps;
    if (due > Date.now()) await sleep(due - Date.now());
    const event = makeEvent(next++ % users);
    fire(post([event]));
    if (scenario === 'redelivery' && Math.random() < redeliver) {
      const copy = { ...event, deliveryContext: { isRedelivery: true } };
      setTimeout(() => fire(post([copy], true)), 2000);
    }
  }
}

async function burst() {
  for (let u = 0; u < users; u++) fire(post([makeEvent(u)]));
}

async function sameUser() {
  for (let u = 0; u < users; u++) {
    for (let m = 0; m < messages; m++) {
      fire(post([makeEvent(u)]));
      await sleep(150);
    }
  }
}

const startedAt = new Date();
console.log(`[gen] run=${run} scenario=${scenario} rps=${rps} duration=${duration}s users=${users}`);
const progress = setInterval(
  () => console.log(`[gen] sent=${stats.sent} ok=${stats.ok} rejected=${JSON.stringify(stats.rejected)} errors=${stats.errors}`),
  10_000,
);
if (scenario === 'burst') await burst();
else if (scenario === 'same-user') await sameUser();
else await steady();
await sleep(2500);
await Promise.allSettled([...inflight]);
clearInterval(progress);

const sorted = stats.latencies.sort((a, b) => a - b);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const summary = {
  run,
  scenario,
  rps,
  duration,
  users,
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  sent: stats.sent,
  accepted: stats.ok,
  rejected: stats.rejected,
  errors: stats.errors,
  ingressMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1) },
};
appendFileSync(`${out}/generator.json`, JSON.stringify(summary) + '\n');
console.log('[gen] done', JSON.stringify(summary));
