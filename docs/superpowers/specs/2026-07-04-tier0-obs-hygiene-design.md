# Tier 0 obs hygiene (Phase D item 14, code parts) — design

Date: 2026-07-04
Status: draft, awaiting user review
Context: ROADMAP Phase D item 14. Four small code changes + one branch merge that make the
backtester observable and non-blocking before the VPS move. Env enablement (dedup/coalesce/obs)
is operational and not part of this spec.

## Goals

1. `/statsz` exposes queue depth + oldest-queued age (the KEDA metric; today a backlog is invisible).
2. A failed job is NEVER silent: bounded error detail is logged at terminal time (with or without
   `BACKTESTER_JOB_OBS`), and `job_terminal` carries it when obs is on.
3. `/v1/capabilities` stops advertising a stale hardcoded `maxConcurrency: 1`.
4. Session teardown stops blocking the worker event loop (`spawnSync` → async, fire-and-forget).
5. The `perf/ipc-profile` instrumentation branch (flag-gated `BACKTESTER_IPC_PROFILE`) merges.

## Non-goals

- No flag-default flips (dedup/coalesce/obs stay default OFF in code).
- No cross-replica aggregation, percentiles, or combined-mode `/statsz` (existing follow-ups).
- No engine/protocol changes (17b/17c are separate specs).
- No queue/schema changes; `result_hash` byte-identical everywhere.

## Design

### 1. Queue depth in `/statsz`

`JobStore` gains `countQueueStats(nowMs): Promise<{ depth: number; oldestQueuedAgeMs: number | null }>`
(Pg: one `SELECT count(*), min(queued_at_ms) FROM backtest_job WHERE status='queued'` — served by the
existing partial index `ix_backtest_job_queued_order`; InMemory: linear scan). The worker health
server calls it per `/statsz` request (no caching — the query is cheap and `/statsz` is low-QPS) and
adds a top-level `queue: { depth, oldestQueuedAgeMs }` block. On store error the block degrades to
`queue: { error: "<bounded>" }` — `/statsz` itself never 500s because of it.

### 2. Worker error visibility

In `processNextQueued`'s catch (worker.ts:637):
- ALWAYS (obs on or off): `console.error(JSON.stringify({ evt: 'job_error', runId, code, detail }))`
  where `detail` = `String(err?.message ?? err)` truncated to 300 chars. Unconditional — a failed
  job with a swallowed cause cost us a debugging session on 2026-07-03.
- When obs is on: `job_terminal` gains optional `errorDetail` (same bounded string) for failed
  outcomes. No schema/API change — log-line only.

### 3. Honest `/v1/capabilities`

`maxConcurrency` becomes the API process's `config.workerConcurrency` (documented as
*per-worker-process* concurrency, not fleet-wide — the API cannot know the fleet size in split
topology; fleet math lives in OPERATIONS capacity budgeting). If the SDK/API contract pins the field
shape, the value change is contract-compatible (same field, same type).

### 4. Async docker teardown

`DockerDriver.kill(name)` / `remove(name)` switch from `spawnSync` to fire-and-forget async
`spawn` (stdio ignored, errors swallowed — teardown is already best-effort and idempotent;
`docker run --rm`-style cleanup semantics preserved by kill→remove ordering via chained callbacks,
not by blocking). `close()` stays synchronous — no ripple into `fail()`/`callHook` signatures.
`inspectState` keeps `spawnSync` IF it sits on the failure-classification path where a result is
required synchronously; if its only callers are async-friendly, convert it too (plan verifies
callers and decides; correctness first, this one is optional).

### 5. Merge `perf/ipc-profile`

Branch `perf/ipc-profile` (commit `b62ca59`, sandbox-session.ts only, flag-gated, zero default
cost) is included in this slice's PR (rebase/merge into the feature branch).

## Testing

- `countQueueStats`: unit for InMemory + Pg-gated test (empty queue → depth 0 / null age; N queued
  → depth N, age from oldest `queued_at_ms`).
- `/statsz` shape: health-server test asserts the `queue` block and the degraded-error path.
- Error visibility: worker test — a job failing with a non-RunnerError asserts the `job_error`
  line (spy on console.error) with truncation; obs-on path asserts `errorDetail` in `job_terminal`.
- Capabilities: existing endpoint test updated to expect `config.workerConcurrency`.
- Teardown: unit — `kill`/`remove` no longer call `spawnSync` (driver test with spawned-process
  fake); existing sandbox lifecycle tests stay green (Docker-gated suite skips on WSL2 — CI is the
  sandbox-path gate, as usual).
- Full `pnpm check` green; `result_hash` goldens untouched.

## Rollout

One PR on a `feat/tier0-obs-hygiene` branch (containing the cherry-picked/merged profile commit).
No flags flipped; `/statsz` and log lines are additive.

## Decisions taken (flag for review)

1. `job_error` line is UNCONDITIONAL (not obs-gated) — silent failures are a bug class, not telemetry.
2. `maxConcurrency` = per-process value with doc note (honest but not fleet-aware).
3. Teardown is fire-and-forget (keeps `close()` sync); `inspectState` conversion optional per plan.
4. Queue stats queried live per `/statsz` hit, no cache.
