#!/usr/bin/env bash
# One isolated scenario: fresh load Redis, seeded wallet, fresh app process,
# metrics, generator, drain, verify. Extra args go to generate-load.mjs.
#   LOAD_DIST=<compiled> LOAD_RESULTS=<dir> test/load/run-scenario.sh <name> --scenario steady --rps 30 --duration 600 --users 1000
# Env knobs (LINE_EVENTS_CONCURRENCY, AI_GLOBAL_LIMIT_PER_SEC, DEFAULT_POOL_MAX, LOAD_AI_*_MS, ...) pass through to the app.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${1:?scenario name}"; shift
: "${LOAD_DIST:?}"
OUT="${LOAD_RESULTS:-${TMPDIR:-/tmp}/chatbot-load-results}/$NAME"
REDIS_CONTAINER="${LOAD_REDIS_CONTAINER:-chatbot-load-redis}"
mkdir -p "$OUT"
cd "$REPO"

docker exec "$REDIS_CONTAINER" redis-cli FLUSHALL >/dev/null
node test/load/seed-load.mjs "$OUT" "${LOAD_TOPUP:-0}"

test/load/run-app.sh >"$OUT/app.log" 2>&1 &
APP=$!
trap 'kill $APP $METRICS 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  grep -q "successfully started" "$OUT/app.log" 2>/dev/null && break
  kill -0 $APP 2>/dev/null || { tail -20 "$OUT/app.log"; exit 1; }
  sleep 1
done
sleep 2

node test/load/collect-metrics.mjs --out "$OUT" --pid "$APP" &
METRICS=$!

RUN="$(echo "$NAME" | tr -cd 'a-z0-9' | cut -c1-12)$(date +%H%M%S)"
node test/load/generate-load.mjs --out "$OUT" --run "$RUN" "$@" | tee "$OUT/generator.log"
node test/load/wait-drain.mjs --timeout "${LOAD_DRAIN_TIMEOUT:-1800}" | tee "$OUT/drain.log"

kill $METRICS 2>/dev/null || true
sed 's/\x1b\[[0-9;]*m//g' "$OUT/app.log" >"$OUT/app.clean.log"
node test/load/verify-load.mjs --out "$OUT" --run "$RUN" --log "$OUT/app.clean.log" >"$OUT/verify.log"
kill $APP 2>/dev/null || true
wait $APP 2>/dev/null || true
echo "[scenario] $NAME done → $OUT/verify.json"
