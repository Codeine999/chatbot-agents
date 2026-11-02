#!/usr/bin/env bash
# Crash recovery: SIGKILL the app while turns are in flight, restart it, then
# check that every event completes once and billing holds stay consistent.
#   LOAD_DIST=<compiled> test/load/run-crash.sh <name> [crashAfterSec] [downSec] -- <generator args>
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${1:?scenario name}"; CRASH_AT="${2:-20}"; DOWN="${3:-5}"; shift 3; [ "${1:-}" = "--" ] && shift
: "${LOAD_DIST:?}"
OUT="${LOAD_RESULTS:-${TMPDIR:-/tmp}/chatbot-load-results}/$NAME"
mkdir -p "$OUT"
cd "$REPO"

start_app() {
  test/load/run-app.sh >>"$OUT/app.log" 2>&1 &
  APP=$!
  for _ in $(seq 1 90); do
    [ "$(grep -c "successfully started" "$OUT/app.log" 2>/dev/null)" -ge "$1" ] && return
    sleep 1
  done
  echo "app did not start"; exit 1
}

docker exec "${LOAD_REDIS_CONTAINER:-chatbot-load-redis}" redis-cli FLUSHALL >/dev/null
node test/load/seed-load.mjs "$OUT" "${LOAD_TOPUP:-0}"
: >"$OUT/app.log"
start_app 1
trap 'kill $APP 2>/dev/null || true' EXIT

RUN="$(echo "$NAME" | tr -cd 'a-z0-9' | cut -c1-12)$(date +%H%M%S)"
node test/load/generate-load.mjs --out "$OUT" --run "$RUN" "$@" >"$OUT/generator.log" &
GEN=$!
sleep "$CRASH_AT"
echo "[crash] SIGKILL app after ${CRASH_AT}s"
kill -9 $APP
sleep "$DOWN"
start_app 2
echo "[crash] app restarted"
wait $GEN || true
node test/load/wait-drain.mjs --timeout "${LOAD_DRAIN_TIMEOUT:-900}" | tee "$OUT/drain.log"

sed 's/\x1b\[[0-9;]*m//g' "$OUT/app.log" >"$OUT/app.clean.log"
node test/load/verify-load.mjs --out "$OUT" --run "$RUN" --log "$OUT/app.clean.log" >"$OUT/verify.log"
echo "[scenario] $NAME done → $OUT/verify.json"
