#!/usr/bin/env bash
# Stop the backtester API + worker (leaves Postgres + mock-platform running).
set -euo pipefail
pkill -f "src/inde[x].ts" 2>/dev/null || true
pkill -f "worker-mai[n]"  2>/dev/null || true
sleep 1
echo "stopped API + worker (backtester-pg + mock-platform left running)"
