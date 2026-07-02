# Controlled dedup enablement + minimal job observability — design

**Date:** 2026-07-02
**Status:** design (pre-plan)
**Slice:** Phase C follow-up to item 11 (fingerprint dedup, shipped dark-launched in PR #73).

## Goal

Make it safe to flip `BACKTESTER_DEDUP_ENABLED=true` in a controlled setting (local /
staging) **and** be able to answer, from real signals rather than guesses:

> Does dedup actually help, and where is the bottleneck — materialization, engine/sandbox,
> or time spent queued?

This is deliberately the *minimum* observability that answers that question. It is not a
metrics platform.

## Non-goals (YAGNI — explicit)

- No Prometheus / OpenTelemetry / metrics library.
- No structured-logging library (pino/winston). We use the bare `console` pattern already
  present in the codebase.
- No dashboards.
- No per-tenant quotas / fairness (deferred — see ROADMAP item 10).
- No scheduler changes.
- No percentiles (p50/p95). `count/sum/max` per phase is enough for a first read;
  percentiles are a follow-up (they need a real histogram/reservoir).
- No `JobStore` surface change. Queue **depth** is not instrumented in this slice — it is
  already answerable via SQL (see below). A `countByStatus()` helper, if wanted, is a
  separate task after this one.

## Current state (from code survey)

- **No logger abstraction.** Logging today is a single ad-hoc `console.warn` in the evidence
  branch of `processNextQueued`.
- **Worker health HTTP already exists but is narrow:** `jobs/worker-health.ts`
  `startWorkerHealthServer(port, state)` serves only `/healthz` + `/readyz`, gated behind an
  optional worker-health port in config (`AppConfig`). The API server (`api/server.ts`)
  serves a public `/health`.
- **All lifecycle timing points are already colocated** in `jobs/worker.ts`
  `processNextQueued`: `claimNextQueued` → (optional bundle load) → `materializeFor` →
  dedup gate (lookup → hit/miss/stale) → engine execute (miss path only) → cache populate →
  `store.transition(..., 'completed'|'failed')`. Timestamps come from the injected
  `deps.clock()`; the job row carries the enqueue timestamp.

## Design

### 1. Single instrumentation site

All timing lives in `processNextQueued`. No timing logic is scattered elsewhere.

Capture, via `deps.clock()`, **only when `BACKTESTER_JOB_OBS` is on**:

- `tClaim` — right after a successful claim.
- `tMaterialized` — right after `materializeFor` returns.
- `tEngineDone` — right after the miss-path engine call returns (absent on a HIT — the
  engine never runs).
- `tTerminal` — at the terminal transition.

Derived durations (all integers, ms):

| field           | formula                          | notes                                  |
|-----------------|----------------------------------|----------------------------------------|
| `queueWaitMs`   | `tClaim − enqueuedAt`            | `enqueuedAt` from the claimed job row   |
| `materializeMs` | `tMaterialized − tClaim`        | includes bundle load (pre-flight)       |
| `engineMs`      | `tEngineDone − tMaterialized`   | `null` on a HIT / stale (engine skipped)|
| `totalMs`       | `tTerminal − tClaim`            | worker wall time for the job            |

**Determinism guard (load-bearing):** every extra `deps.clock()` call is inside the
`BACKTESTER_JOB_OBS` guard. With the flag off (default), `processNextQueued` calls
`deps.clock()` exactly as it does today, so the byte-equivalence goldens (which run with the
flag off) see an unchanged clock-call count. This is the reason observability is behind its
own flag rather than always-on.

### 2. Dedup classification (one field: `dedup`)

Exactly one of:

| value              | condition                                                                    |
|--------------------|------------------------------------------------------------------------------|
| `off`              | dedup disabled (`dedupEnabled !== true` or no `resultCache`)                  |
| `evidence_bypass`  | dedup enabled **but** `curatedBaselineRef` set → run bypasses dedup entirely  |
| `bypass`           | `dedupOn` and `bypassCache === true` (lookup skipped, fresh run still populates)|
| `hit`              | lookup returned a row, template valid → re-stamped, engine skipped            |
| `stale_recompute`  | lookup returned a row but template shape/engine/version mismatch or read threw → recompute |
| `miss`             | lookup ran, no row → recompute + populate                                    |

`stale_recompute` requires distinguishing "a hit row was found but rejected" from a plain
miss. Today both fall through to `finalized === undefined`. Add one local boolean set in the
existing hit-rejection branches (the `template.engine`/`templateVersion` mismatch case and
the `catch` around `artifactStore.read`).

### 3. Delivery — two channels, one flag `BACKTESTER_JOB_OBS` (default OFF)

Both channels are fed from the single instrumentation site.

**(a) Structured per-job terminal log line** — one line per terminal job (both `completed`
and `failed`), emitted with the bare `console` pattern (no logger dependency):

```jsonc
{
  "evt": "job_terminal",
  "runId": "…",
  "engine": "momentum" | "overlay" | "strategy",
  "outcome": "completed" | "failed" | "…",   // terminal status
  "terminalCode": "…",                        // present on non-completed
  "dedup": "off" | "evidence_bypass" | "bypass" | "hit" | "miss" | "stale_recompute",
  "queueWaitMs": 12,
  "materializeMs": 40,
  "engineMs": 0 | null,
  "totalMs": 55,
  "ts": 1751000000000
}
```

Durable, aggregatable with `jq` across replicas (logs concatenate). Source of truth.

**(b) `/statsz` in-process counters snapshot** — a small `ObsRegistry` accumulated in the
worker process:

- counts by `outcome`,
- counts by `dedup` class,
- per phase (`queueWaitMs`/`materializeMs`/`engineMs`/`totalMs`): `count` / `sum` / `max`
  (avg is `sum/count`; **no** percentiles).

Served as JSON. `ObsRegistry` counts **since process start** only; it resets on restart and
is per-process (not aggregated across replicas) — the durable log line is the cross-replica
source of truth.

### 4. `/statsz` topology (first PR: worker health server only)

- **worker-main (split topology):** `/statsz` is added to `startWorkerHealthServer` (gated
  by the existing `WORKER_HEALTH_PORT`). The worker loop and the health server live in the
  same process, both holding the same `ObsRegistry` instance (wired through `WorkerDeps`).
- **combined `AUTO_WORKER=true`:** this PR does **not** add a `/statsz` route to the public
  API server — avoiding any auth/route-policy debate over exposing internal counters on the
  public surface. In combined mode the job log line still fires (durable channel); the live
  snapshot is simply unavailable. Documented as a known first-slice limitation. Exposing
  `/statsz` in combined mode is a follow-up only if it lands without policy friction.

`ObsRegistry` itself is created and wired regardless of topology (so the log line and
counters accumulate wherever the worker loop runs); only the HTTP *exposure* is
worker-health-only in this slice.

### 5. Queue depth — not instrumented here

Point-in-time queue depth (queued/running/…) has an existing source of truth: the
`backtest_job` status column. Documented in `OPERATIONS.md` as:

```sql
SELECT status, count(*) FROM backtest_job GROUP BY status;
```

`/statsz` shows in-process counters since start, **not** queue depth. A `countByStatus()`
store helper (to fold depth into `/statsz`) is a separate follow-up task, deliberately out
of this PR to avoid a `JobStore` surface change.

## Components / boundaries

- `jobs/obs-registry.ts` — `ObsRegistry`: `recordJob(sample)` + `snapshot()`. Pure
  in-memory; no I/O; unit-testable in isolation. `snapshot()` shape is the `/statsz` body.
- `jobs/worker.ts` — the single instrumentation site: gathers the sample (durations +
  `dedup` class + outcome) and, when `deps.obs` is present, (i) `console.log`s the terminal
  line and (ii) calls `deps.obs.recordJob(...)`. When `deps.obs` is absent → no clock
  overhead, no output.
- `jobs/worker-health.ts` — `startWorkerHealthServer` gains an optional stats provider;
  `/statsz` returns `provider.snapshot()` (404 when no provider, i.e. obs off).
- Wiring: `config.ts` reads `BACKTESTER_JOB_OBS`; `app.ts` / `worker-main.ts` construct the
  `ObsRegistry` and pass it into `WorkerDeps` and the health server only when the flag is on.

## Error handling

- Observability must never affect job outcome. The `recordJob` + log emission run **after**
  the terminal transition, off the result path. Any throw there is swallowed (best-effort);
  it cannot fail a job.
- `/statsz` with no provider → `404` (consistent with the existing health-server 404 for
  unknown routes).

## Testing

- **`ObsRegistry` unit:** `recordJob` accumulation → `snapshot()` count/sum/max per phase and
  per class. Pure, no I/O.
- **Dedup classification unit:** drive `processNextQueued` through each of
  `off | evidence_bypass | bypass | hit | miss | stale_recompute` and assert the emitted
  `dedup` value (spy on `ObsRegistry.recordJob`). `hit`/`stale_recompute` reuse the existing
  dedup-worker test fixtures.
- **Duration breakdown unit:** fake clock → assert `queueWaitMs`/`materializeMs`/`engineMs`/
  `totalMs`; assert `engineMs` is null/absent on a HIT.
- **Flag-off invariant:** with `BACKTESTER_JOB_OBS` off — (i) no log line, (ii) `/statsz`
  404, and (iii) the `deps.clock()` call count is unchanged vs a baseline run (guards the
  goldens' determinism).
- **`/statsz` shape:** flag on → 200 + the documented snapshot JSON.

## Acceptance

- `BACKTESTER_JOB_OBS=false` (default) → no per-job log line, `/statsz` 404, **zero**
  additional `deps.clock()` calls; existing goldens byte-identical.
- `BACKTESTER_JOB_OBS=true` → each terminal job emits the JSON line (with `dedup` class +
  duration breakdown); worker-health `/statsz` serves the live in-process snapshot.
- A real sweep + `jq` over the log lines (and/or `/statsz`) lets an operator answer by hand:
  is dedup helping, and is the bottleneck materialization / engine / queue-wait.
- No Prometheus/OTel/logger/dashboard/scheduler changes; no `JobStore` surface change.

## Follow-ups (explicitly out of this slice)

- Percentiles (p50/p95) via a real histogram/reservoir.
- `countByStatus()` store helper → queue depth in `/statsz`.
- `/statsz` in combined `AUTO_WORKER` mode (if it lands without public-API policy friction).
- Cross-replica aggregation (today: concatenate log lines).
