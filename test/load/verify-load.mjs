// Checks pipeline and billing correctness after a run has drained.
//   LOAD_DIST=... node test/load/verify-load.mjs --out <dir> --run <runId>
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRedis, percentile, pg } from './lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const out = args.out ?? 'load-results';
const runId = args.run;
if (!runId) throw new Error('--run is required');
const before = JSON.parse(readFileSync(`${out}/before.json`, 'utf8'));
const manifest = readFileSync(`${out}/manifest.jsonl`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((e) => e.id.startsWith(`ev-${runId}-`));

const db = pg();
const redis = loadRedis();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const evLike = `ev-${runId}-%`;
const userLike = `Uload${runId}%`;

const events = new Map();
for (const e of manifest) {
  const seen = events.get(e.id);
  events.set(e.id, { ...e, accepted: (seen?.accepted ?? false) || e.status === 200 });
}
const accepted = [...events.values()].filter((e) => e.accepted);

const webhook = await q(
  `select status, count(*)::int n, max(attempts)::int max_attempts
     from "processedLineWebhookEvent" where "webhookEventId" like $1 group by status`,
  [evLike],
);
const claimedIds = new Set(
  (await q(`select "webhookEventId" id from "processedLineWebhookEvent" where "webhookEventId" like $1`, [evLike])).map((r) => r.id),
);

const history = await q(
  `select coalesce(h."lineMessageId", h."rawEvent"->>'webhookEventId') k, count(*)::int n
     from "lineChatHistory" h join "lineMember" m on m.id = h."lineMemberId"
    where m."lineUserId" like $1 and h.sender = 'user' group by 1`,
  [userLike],
);
const unread = await q(
  `select c.id, c."unreadCount" unread, c.status,
          (select count(*)::int from "lineChatHistory" h where h."conversationId" = c.id and h.sender = 'user') user_rows
     from "lineConversation" c join "lineMember" m on m.id = c."lineMemberId" where m."lineUserId" like $1`,
  [userLike],
);

const deliveries = await q(
  // Prisma stores UTC in `timestamp without time zone`; read epochs so the
  // driver does not reinterpret them in the local time zone.
  `select key, status, method, attempts, text, "lastError",
          (extract(epoch from "acceptedAt") * 1000)::float8 accepted_ms
     from "lineDelivery" where key like $1`,
  [evLike],
);
const fallbackTexts = new Set(
  (await q(`select "fallbackMessage" t from "aiSettings" where "fallbackMessage" is not null`)).map((r) => r.t),
);

const byStatusMethod = {};
const endToEnd = [];
const perUser = new Map();
let fallbackReplies = 0;
for (const d of deliveries) {
  const k = `${d.status}/${d.method}`;
  byStatusMethod[k] = (byStatusMethod[k] ?? 0) + 1;
  if (fallbackTexts.has(d.text)) fallbackReplies += 1;
  const e = events.get(d.key);
  if (e && d.accepted_ms) {
    endToEnd.push(d.accepted_ms - e.ts);
    const list = perUser.get(e.user) ?? [];
    list.push({ seq: e.seq, at: d.accepted_ms });
    perUser.set(e.user, list);
  }
}
let orderViolations = 0;
for (const list of perUser.values()) {
  list.sort((a, b) => a.at - b.at || a.seq - b.seq);
  for (let i = 1; i < list.length; i++) if (list[i].seq < list[i - 1].seq) orderViolations += 1;
}
endToEnd.sort((a, b) => a - b);

// ------------------------------------------------------------------ billing
const since = before.takenAt;
const usage = await q(
  `select kind, status, count(*)::int n, coalesce(sum("chargedCredit"),0)::text charged,
          coalesce(sum("costThb"),0)::text cost_thb
     from "aiUsageEvents" where "createdAt" > $1 group by kind, status order by kind, status`,
  [since],
);
const usageTotal = usage.reduce((n, r) => n + r.n, 0);
const [ledger] = await q(
  `select count(*)::int debits, coalesce(sum("amountCredit"),0)::text debit_sum,
          count(*) filter (where "amountCredit" >= 0)::int non_negative_debits
     from "creditLedger" where type = 'DEBIT' and "createdAt" > $1`,
  [since],
);
const [charged] = await q(
  `select coalesce(sum("chargedCredit"),0)::text charged,
          count(*) filter (where "chargedCredit" > 0)::int billable
     from "aiUsageEvents" where "createdAt" > $1 and status = 'success'`,
  [since],
);
const [unmatched] = await q(
  `select count(*)::int n from "aiUsageEvents" u
     where u."createdAt" > $1 and u.status = 'success' and u."chargedCredit" > 0
       and (select count(*) from "creditLedger" l where l."usageEventId" = u.id) <> 1`,
  [since],
);
const [wallet] = await q(
  `select "balanceCredit"::text balance, "reservedCredit"::text reserved, "lifetimeSpentCredit"::text spent
     from "creditWallets" where id = $1`,
  [before.wallet.id],
);
const budgets = await q(
  `select kind, "scopeKey", "usedCredit"::text used, "reservedCredit"::text reserved from "creditBudgets" where "walletId" = $1`,
  [before.wallet.id],
);
const reservations = await q(
  `select status, count(*)::int n from "creditReservation" where "createdAt" > $1 group by status`,
  [since],
);
const dec = (s) => Number(s);
const balanceDrop = dec(before.wallet.balanceCredit) - dec(wallet.balance);
const spentRise = dec(wallet.spent) - dec(before.wallet.lifetimeSpentCredit);

const counters = Object.fromEntries(
  await Promise.all(
    (await redis.keys('load:*'))
      .filter((k) => !k.startsWith('load:rt:') && !k.startsWith('load:retry:'))
      .map(async (k) => [k.slice(5), Number(await redis.get(k))]),
  ),
);
const providerCalls = (counters['ai:generate'] ?? 0) + (counters['ai:generate_error'] ?? 0) + (counters['ai:embed'] ?? 0);

// App log evidence for limits that degrade answers without failing the job.
const LOG_SIGNALS = {
  aiBudgetGlobal: /AI budget exceeded \(global\)/,
  aiBudgetUser: /AI budget exceeded \(user/,
  replyLimit: /global reply limit exceeded/,
  creditTxRetry: /Retrying .* AI credit transaction/,
  burstLimit: /burst limit exceeded/,
  hourlyLimit: /hourly limit exceeded/,
  spam: /spam detected/,
  leaseLost: /Webhook lease lost/,
  pendingUsage: /PendingAiUsage|AI usage settlement is pending/,
  blockedExternal: /load harness blocked external call/,
};
const logSignals = {};
if (args.log) {
  const lines = readFileSync(args.log, 'utf8').split('\n');
  for (const [name, pattern] of Object.entries(LOG_SIGNALS)) {
    logSignals[name] = lines.filter((line) => pattern.test(line)).length;
  }
}

const report = {
  run: runId,
  logSignals,
  events: {
    unique: events.size,
    accepted: accepted.length,
    rejectedAtIngress: events.size - accepted.length,
    redeliveriesSent: manifest.filter((e) => e.redelivery).length,
    neverClaimed: accepted.filter((e) => !claimedIds.has(e.id)).length,
    webhookStatus: webhook,
  },
  inbound: {
    userRows: history.reduce((n, r) => n + r.n, 0),
    duplicateKeys: history.filter((r) => r.n > 1).length,
    unreadMismatch: unread.filter((c) => c.unread !== c.user_rows).length,
    waitingAdmin: unread.filter((c) => c.status === 'waiting_admin').length,
    conversations: unread.length,
  },
  delivery: {
    rows: deliveries.length,
    byStatusMethod,
    fallbackReplies,
    orderViolations,
    endToEndMs: {
      p50: percentile(endToEnd, 50),
      p95: percentile(endToEnd, 95),
      p99: percentile(endToEnd, 99),
      max: endToEnd.at(-1) ?? null,
    },
    lastErrors: [...new Set(deliveries.map((d) => d.lastError).filter(Boolean))].slice(0, 5),
  },
  billing: {
    usage,
    usageEvents: usageTotal,
    providerCalls,
    unbilledProviderCalls: providerCalls - usageTotal,
    debits: ledger.debits,
    billableUsage: charged.billable,
    debitSum: ledger.debit_sum,
    chargedSum: charged.charged,
    debitEqualsCharged: Math.abs(dec(ledger.debit_sum) + dec(charged.charged)) < 1e-6,
    nonNegativeDebits: ledger.non_negative_debits,
    usageWithoutExactlyOneDebit: unmatched.n,
    walletBalanceDrop: balanceDrop.toFixed(6),
    walletDropEqualsDebits: Math.abs(balanceDrop + dec(ledger.debit_sum)) < 1e-6,
    lifetimeSpentRiseEqualsDebits: Math.abs(spentRise + dec(ledger.debit_sum)) < 1e-6,
    walletReserved: wallet.reserved,
    budgets,
    reservations,
  },
  counters,
};
writeFileSync(`${out}/verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await Promise.allSettled([db.end(), redis.quit()]);
