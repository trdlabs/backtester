#!/usr/bin/env bash
# Bring up the single-user backtester stand (API + worker) with dedup/coalescing ON.
# Postgres (backtester-pg) and mock-platform are assumed already running.
# Idempotent: kills any prior API/worker first. Logs to $LOG_DIR.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$HERE/backtester.env}"
REPO="${BT_REPO:-/root/projects/trading-backtester}"
LOG_DIR="${BT_LOG_DIR:-/root/bt-logs}"
mkdir -p "$LOG_DIR"
[ -f "$ENV_FILE" ] || { echo "missing env file: $ENV_FILE (copy backtester.env.example)"; exit 1; }

set -a; . "$ENV_FILE"; set +a
: "${BACKTESTER_ARTIFACTS_DIR:?}"; : "${BACKTESTER_BUNDLES_DIR:?}"
mkdir -p "$BACKTESTER_ARTIFACTS_DIR" "$BACKTESTER_BUNDLES_DIR"

echo "==> stopping any prior API/worker"
pkill -f "src/inde[x].ts" 2>/dev/null || true
pkill -f "worker-mai[n]"  2>/dev/null || true
sleep 2

cd "$REPO/apps/backtester"
echo "==> starting API on :$BACKTESTER_PORT (AUTO_WORKER=false)"
BACKTESTER_AUTO_WORKER=false setsid pnpm exec tsx src/index.ts > "$LOG_DIR/api.log" 2>&1 < /dev/null &
for i in $(seq 1 30); do
  curl -s -m 2 "http://$BACKTESTER_HOST:$BACKTESTER_PORT/v1/capabilities" -H "Authorization: Bearer $BACKTESTER_AUTH_TOKEN" >/dev/null 2>&1 && break
  sleep 1
done

echo "==> starting worker (concurrency=$WORKER_CONCURRENCY, health :$WORKER_HEALTH_PORT)"
setsid pnpm exec tsx src/worker-main.ts > "$LOG_DIR/worker.log" 2>&1 < /dev/null &
for i in $(seq 1 30); do grep -q draining "$LOG_DIR/worker.log" 2>/dev/null && break; sleep 1; done

echo "==> up. dedup=$BACKTESTER_DEDUP_ENABLED coalesce=$BACKTESTER_COALESCE_ENABLED obs=$BACKTESTER_JOB_OBS"
curl -s -m 3 "http://$BACKTESTER_HOST:$BACKTESTER_PORT/v1/capabilities" -H "Authorization: Bearer $BACKTESTER_AUTH_TOKEN"; echo
