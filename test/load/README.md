# Internal load test (no real LINE / AI calls)

Runs the **real compiled app** (Fastify ingress, signature guard, BullMQ
workers, Prisma, billing, delivery) with only the network edges replaced:

- `preload.cjs` is loaded with `node -r` before the app. It answers
  `api.line.me` / `api-data.line.me` with a fake LINE API (single-use reply
  tokens that expire after 60s, push retry-key dedup, profile, loading,
  image content), replaces the Gemini/OpenRouter generation adapters and the
  embedding adapter with fakes (configurable latency, realistic token usage),
  and **throws on every other non-local host**. Billing runs for real: the
  fake responses carry token usage, so reservations, usage events, ledger
  DEBITs and wallet totals are written exactly as in production.
- No production endpoint, module or dependency was added for this.

Results (`manifest.jsonl`, `metrics.csv`, `verify.json`, `app.log`) go to
`$LOAD_RESULTS/<scenario>` (default `/tmp/chatbot-load-results`).

## Local setup (once)

```bash
# Isolated Postgres/Redis sized like a 2 vCPU / 2 GB VPS share. Never point
# the harness at the dev or production database: every script refuses a
# DATABASE_URL without "load" or "staging" in it.
docker run -d --name chatbot-load-pg --cpus=1 --memory=1g \
  -e POSTGRES_USER=chatbot -e POSTGRES_PASSWORD=loadtest -e POSTGRES_DB=chatbot_load \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16 \
  -c shared_buffers=512MB -c effective_cache_size=1GB -c work_mem=4MB -c max_connections=50
docker run -d --name chatbot-load-redis --cpus=0.25 --memory=256m \
  -p 127.0.0.1:56379:6379 redis:7-alpine

# Realistic data: clone the dev database (knowledge, products, pricing, AI settings).
docker exec nest-postgres pg_dump -U chatbot -d app_db --no-owner --no-privileges \
  | docker exec -i chatbot-load-pg psql -U chatbot -d chatbot_load -q

# Compile outside dist/ so a running dev server is not touched.
export LOAD_DIST=/tmp/chatbot-load-dist
bunx tsc -p tsconfig.build.json --outDir "$LOAD_DIST" --incremental false
ln -sfn "$PWD/node_modules" "$LOAD_DIST/node_modules"

# First seed tops the wallet up (TOPUP ledger row) and removes the stored LINE
# channel so the dummy env credentials are used.
node test/load/seed-load.mjs /tmp/chatbot-load-results/seed 1000000
```

## Running scenarios

```bash
export LOAD_DIST=/tmp/chatbot-load-dist LOAD_TASKSET=2   # pin the app to one core
test/load/run-scenario.sh burst50   --scenario burst --users 50
test/load/run-scenario.sh sameuser  --scenario same-user --users 20 --messages 5
test/load/run-scenario.sh redeliver --scenario redelivery --rps 2 --duration 60 --redeliver 0.2
test/load/run-scenario.sh steady30  --scenario steady --rps 30 --duration 600 --users 1000

# Tuning sweep: any app env var passes through.
LINE_EVENTS_CONCURRENCY=120 LINE_EVENTS_RATE_LIMIT_MAX=60 AI_GLOBAL_LIMIT_PER_SEC=150 \
  test/load/run-scenario.sh tuned30 --scenario steady --rps 30 --duration 600 --users 1000
```

Crash recovery (SIGKILL after 20s, 5s down, then restart):

```bash
test/load/run-crash.sh crash 20 5 -- --scenario steady --rps 10 --duration 45 --users 300
```

Each scenario flushes the load Redis, snapshots billing (`before.json`),
starts a fresh app, samples metrics every 5s, sends load, waits until queues,
webhook leases and deliveries are drained, then writes `verify.json`.

Fake behaviour knobs (ms ranges `min-max`): `LOAD_AI_ANSWER_MS` (1500-4000),
`LOAD_AI_STRUCTURED_MS` (400-1200), `LOAD_AI_EMBED_MS` (120-300),
`LOAD_LINE_MS` (80-250), `LOAD_AI_ERROR_RATE` (0), `LOAD_CLASSIFIER_GENERAL_RATE`
(1 = low-confidence questions are answered by AI; lower values send that share
to the contact-admin fallback), `LOAD_SUPPRESS_DEBUG=1` (mute Nest debug/verbose
logs to measure their cost).

Fake embeddings do not match stored knowledge vectors, so text turns take
the low-confidence path: embedding → classifier → general answer (~2.5 AI
calls per turn), which is the AI-heaviest common path.

## What `verify.json` checks

- every accepted event claimed once and `COMPLETED`; USER history rows not
  duplicated; `unreadCount` equals USER rows per conversation
- deliveries by status/method (REPLY vs PUSH), end-to-end latency
  (LINE event timestamp → LINE accepted), per-user reply order
- billing: provider calls = usage events (nothing unbilled), one DEBIT per
  billable usage, Σ DEBIT = Σ chargedCredit = wallet balance drop = lifetime
  spent rise, wallet/budget `reservedCredit` back to 0, reservations SETTLED
- log signals: AI budget denials, reply limit, credit tx retries (P2034),
  abuse limits, lease loss, blocked external calls

## Staging

Run the same scripts on the staging VPS against the **staging** database and
Redis (`LOAD_DATABASE_URL`, `LOAD_REDIS_HOST/PORT`, `LOAD_REDIS_CONTAINER`).
See `docs/audit-uat-2026-11-01.th.md` for the pgbench / sweep runbook.
