# VPS single-user stand (backtester)

Durable launch config for the on-demand, single-user backtester deployment.
The point of this folder: **dedup + in-flight coalescing are enabled here** as
the recommended single-user posture (both default OFF in code — see
`docs/OPERATIONS.md` § "Result dedup"). Enablement is an operational choice
captured in config, not a code default flip.

## Prerequisites (already provisioned on 89.124.86.84)

- `backtester-pg` Postgres container on `127.0.0.1:15433`.
- mock-platform on `127.0.0.1:8890` (`MOCK_SNAPSHOT_REF=fixtures/2026-06-16-to-18-extended`).
- Repo synced to `/root/projects/trading-backtester`, deps installed, SDK built
  (`pnpm --filter @trdlabs/backtester-sdk build` after any rsync).

## Use

```bash
cp backtester.env.example backtester.env   # then fill CHANGE_ME secrets
./up.sh        # start API + worker with dedup/coalescing ON
./down.sh      # stop API + worker (leaves Postgres + mock running)
```

`up.sh` is idempotent (kills any prior API/worker first) and waits for health.

## Verify the flags took effect

Fire two identical runs concurrently, then a third later:

- concurrent identical → one leader runs the engine, the rest **coalesce**
  (`waiting_for_compute`, shown as `running`); followers finish via re-stamp.
- a later identical run → **dedup HIT** (`"dedup":"hit","engineMs":null`).

Read the terminal log lines (`BACKTESTER_JOB_OBS=true`):

```bash
grep job_terminal /root/bt-logs/worker.log \
  | jq -s 'map(select(.outcome=="completed"))|group_by(.dedup)|map({(.[0].dedup):length})'
```

Queue depth (not in `/statsz`):

```bash
docker exec backtester-pg psql -U backtester -d backtester \
  -c "SELECT status, count(*) FROM backtest_job GROUP BY status;"
```

## Rollback

Set `BACKTESTER_DEDUP_ENABLED=false` (also disables coalescing, which requires
dedup) in `backtester.env` and `./up.sh` again. The OFF path is byte-identical
to pre-dedup behavior; `result_hash` is unaffected either way.

## Capacity note

This box (2 vCPU / 4 GB) also runs the live trading platform. The stand is
**on-demand**: bring it up for real backtests, `./down.sh` when idle so the
sandbox runs don't contend with live bots for CPU. `WORKER_CONCURRENCY=2` lets
coalescing engage in one process; when you scale out, prefer process-per-slot
(concurrency=1 × N workers) — strategy runs don't overlap in one JS thread.
