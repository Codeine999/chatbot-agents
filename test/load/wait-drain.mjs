// Waits until both LINE queues and pending deliveries are empty (or --timeout seconds pass).
import { loadRedis, pg } from './lib.mjs';

const timeoutSec = Number(process.argv[process.argv.indexOf('--timeout') + 1] || 1800);
const redis = loadRedis();
const db = pg();
const started = Date.now();
let quietSince = 0;

async function backlog() {
  let jobs = 0;
  for (const name of ['line-events', 'line-events-retry']) {
    const k = (s) => `bull:${name}:${s}`;
    jobs += (await redis.llen(k('wait'))) + (await redis.llen(k('active'))) +
      (await redis.zcard(k('delayed'))) + (await redis.zcard(k('prioritized')));
  }
  const [{ n }] = (
    await db.query(
      `select count(*)::int n from "lineDelivery"
        where status in ('PENDING','SENDING') or (status = 'ACCEPTED' and "finalizedAt" is null)`,
    )
  ).rows;
  const [{ w }] = (
    await db.query(`select count(*)::int w from "processedLineWebhookEvent" where status in ('PROCESSING','RETRY')`)
  ).rows;
  return { jobs, deliveries: n, webhooks: w };
}

for (;;) {
  const b = await backlog();
  const elapsed = Math.round((Date.now() - started) / 1000);
  if (b.jobs + b.deliveries + b.webhooks === 0) {
    quietSince ||= Date.now();
    // Recovery timers run every 5–15s; stay empty for 20s before calling it drained.
    if (Date.now() - quietSince > 20_000) {
      console.log(`[drain] empty after ${elapsed}s`);
      break;
    }
  } else quietSince = 0;
  if (elapsed > timeoutSec) {
    console.log(`[drain] timeout after ${elapsed}s, backlog=${JSON.stringify(b)}`);
    break;
  }
  if (elapsed % 30 === 0) console.log(`[drain] ${elapsed}s backlog=${JSON.stringify(b)}`);
  await new Promise((r) => setTimeout(r, 1000));
}
await Promise.allSettled([db.end(), redis.quit()]);
