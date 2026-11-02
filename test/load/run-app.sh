#!/usr/bin/env bash
# Starts the compiled app against the load Postgres/Redis with fake LINE/AI.
# Usage: LOAD_DIST=/path/to/compiled test/load/run-app.sh  (env overrides allowed)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
: "${LOAD_DIST:?build first: bunx tsc -p tsconfig.build.json --outDir <dir> --incremental false}"

# Infrastructure: never the dev/production database or Redis.
export DATABASE_URL="${LOAD_DATABASE_URL:-postgresql://chatbot:loadtest@127.0.0.1:55432/chatbot_load?schema=public}"
export REDIS_HOST="${LOAD_REDIS_HOST:-127.0.0.1}" REDIS_PORT="${LOAD_REDIS_PORT:-56379}" REDIS_PASSWORD=""
export PORT="${LOAD_PORT:-18090}"
# Dummy credentials: the preload answers LINE and blocks every other host.
export LINE_CHANNEL_SECRET="load-secret" LINE_CHANNEL_ACCESS_TOKEN="load-token"
export GEMINI_API_KEY="load-dummy" OPEN_ROUTER_KEY="load-dummy"
export GEMINI_EMBEDDING_MODEL="${GEMINI_EMBEDDING_MODEL:-gemini-embedding-2}"

# Throughput knobs pinned to the code defaults unless overridden.
export LINE_EVENTS_CONCURRENCY="${LINE_EVENTS_CONCURRENCY:-10}"
export LINE_EVENTS_RETRY_CONCURRENCY="${LINE_EVENTS_RETRY_CONCURRENCY:-3}"
export LINE_EVENTS_RATE_LIMIT_MAX="${LINE_EVENTS_RATE_LIMIT_MAX:-12}"
export LINE_EVENTS_RATE_LIMIT_DURATION_MS="${LINE_EVENTS_RATE_LIMIT_DURATION_MS:-1000}"
export AI_GLOBAL_LIMIT_PER_SEC="${AI_GLOBAL_LIMIT_PER_SEC:-30}"
export AI_USER_LIMIT_PER_HOUR="${AI_USER_LIMIT_PER_HOUR:-60}"
export LINE_GLOBAL_REPLY_LIMIT_PER_SEC="${LINE_GLOBAL_REPLY_LIMIT_PER_SEC:-30}"
export LINE_GLOBAL_INGRESS_LIMIT_PER_SEC="${LINE_GLOBAL_INGRESS_LIMIT_PER_SEC:-100}"
export LINE_USER_BURST_LIMIT="${LINE_USER_BURST_LIMIT:-10}"
export LINE_USER_BURST_WINDOW_SEC="${LINE_USER_BURST_WINDOW_SEC:-10}"
export LINE_USER_HOURLY_LIMIT="${LINE_USER_HOURLY_LIMIT:-60}"
export DEFAULT_POOL_MAX="${DEFAULT_POOL_MAX:-20}"

export LOAD_DIST NODE_PATH="$REPO/node_modules" NODE_ENV="${NODE_ENV:-production}"
cd "$REPO"
# Optional CPU pinning to mimic a small VPS, e.g. LOAD_TASKSET=0
exec ${LOAD_TASKSET:+taskset -c "$LOAD_TASKSET"} node --max-old-space-size="${LOAD_HEAP_MB:-512}" \
  -r "$REPO/test/load/preload.cjs" "$LOAD_DIST/src/main.js"
