# Parallel workers (perf #2) — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming), pending spec review
**Branch:** `feat/parallel-workers`

## Problem

The worker drains the queue strictly serially: `drainQueue` runs
`while ((await processNextQueued(deps)) !== undefined)`, one job at a time, on a
single 200 ms tick guarded by a `busy` re-entrancy flag (`worker.ts`, `app.ts`).
A parameter sweep — e.g. one strategy run for a parameter stepped 0.0 → 1.0 by
0.1, 11 backtests over the *same* data slice — is executed one-after-another even
though the runs are independent.

The target workload is **sandboxed (untrusted) strategies**, which execute via
per-bar IPC to a child process / container. Such runs spend most of their
wall-clock **waiting** on that child process — they are I/O-bound. Running them
serially leaves the event loop idle during every wait.

## Approach (and why)

**(A) Bounded in-process async concurrency.** Run up to `N` `processNextQueued`
executions concurrently inside the single worker process. While one sandboxed
run awaits its child-process round-trip, the event loop drives the others →
near-linear speedup for I/O-bound sweeps.

Rejected alternatives (YAGNI — all address CPU-bound scale we do not have):

- **Worker threads** — true CPU parallelism, but threads do not share the JS
  heap, so the in-process tape cache (perf #1) could not be shared; needs the
  tape serialized across the thread boundary. Complex, breaks #1's synergy.
- **Multiple processes** — true CPU parallelism, but each process gets its own
  tape cache (no sharing) → reopens the L2/Redis question we deliberately
  closed. Heaviest ops.

(A) is the only option that **preserves the shared in-process tape cache**: a
sweep hits one cache key, materializes the tape once, and runs `N` at a time
against that one shared (immutable) object. This is why (A) is correct for the
sweep workload specifically, independent of profile — and the dominant runs
(sandboxed) are I/O-bound, exactly where (A) delivers.

## Key facts (grounded in code)

- Serial today: `drainQueue` (`worker.ts:301`), `tick`/`busy`/`setInterval(…, 200)`
  (`app.ts:114`), `maxConcurrency` hardcoded to 1 (`app.ts:151`, unused by the worker).
- Claim safety:
  - `PgJobStore.claimNextQueued` (`pg-job-store.ts:211`) uses
    `FOR UPDATE SKIP LOCKED` in a CTE — atomic and safe for concurrent claimers
    (in-process and cross-process). No change needed.
  - `InMemoryJobStore.claimNextQueued` (`job-store.ts:165`) filters/sorts the job
    map then `await`s a `transition('queued' → 'running')`. Two concurrent
    callers can both select `queued[0]`; the awaited transition is the only
    guard. Needs serialization under in-process concurrency.
- Execution profile: the sandbox executor (`sandbox/sandbox-executor.ts`) awaits a
  child-process/container round-trip (I/O-bound). The trusted momentum executor
  (`runner/module-executor.ts`) is a synchronous CPU-bound loop. Sweeps of
  sandboxed strategies are I/O-bound.
- Race surface under same-process concurrency:
  - Tape cache: **safe** — `getOrBuild` has no `await` between the `get` miss and
    the `set`, so concurrent same-key callers cannot double-build.
  - `FileArtifactStore.write` (`artifacts/store.ts`): `writeFile` to a
    content-addressed path is not atomic; two concurrent writers of the same
    artifact can interleave → a torn read is possible. Needs atomic write.
  - `harness-volume` (`engine/sandbox/harness-volume.ts:46`): the temp dir is
    `${dest}.tmp-${process.pid}` — same pid for two concurrent same-process
    runs → collision risk if this path runs per-run.
  - `InMemoryArtifactStore`: a `Map.set` is not interrupted mid-statement in
    single-threaded async — **safe** under (A); no fix.
  - RNG (`determinism/rng.ts`): per-run closure state — safe.
- Config knobs today: `BACKTESTER_AUTO_WORKER`, `TAPE_CACHE_MAX_ENTRIES`,
  queue/run timeouts. No worker-concurrency knob.

## Design

### 1. Bounded worker pool

Replace the serial drain with a bounded pool of up to `N` concurrent
`processNextQueued` executions in the one worker process. Each pool slot loops
`while ((await processNextQueued(deps)) !== undefined)`; when the queue empties,
all slots receive `undefined` and exit, ending the drain. The existing 200 ms
`tick` + `busy` guard wrap the pool drain unchanged (a tick starts the pool,
awaits the drain, clears `busy`). `reap()` and `flushOutbox()` stay as-is.

The shared in-process tape cache (perf #1) is unchanged and continues to serve
all concurrent runs from one process.

### 2. Concurrency control

New knob `WORKER_CONCURRENCY` (env → `AppConfig` field), **default 4**.
`WORKER_CONCURRENCY=1` reproduces the current strictly-serial behavior exactly
(the safe fallback). The value is the upper bound on simultaneous sandboxed
runs — each spawns child processes/containers with their own resource limits, so
this is the lever for fitting the host. The value is clamped to `>= 1`.

### 3. Claim safety

- `PgJobStore` — unchanged (`SKIP LOCKED` already atomic).
- `InMemoryJobStore` — add an in-process async mutex around the claim body
  (filter + sort + transition) so two pool slots cannot claim the same job. Only
  the **claim step** is serialized (cheap); the runs proceed concurrently. The
  lock lives inside the store implementation, so the pool is store-agnostic and
  the pg path is untouched.

### 4. Concurrency-safety hardening

- **`FileArtifactStore.write`** — write to a unique temp file then atomically
  `rename` to the content-addressed path, so concurrent writers of the same
  artifact can never produce a torn read.
- **`harness-volume`** — confirm whether `ensureHarnessInVolume` runs per-run;
  if so, give the temp dir a unique suffix (e.g. a random token) instead of bare
  `process.pid`, so two concurrent same-process sandbox runs cannot collide. If
  it runs once at startup, no change (document why).
- No change to the tape cache, `InMemoryArtifactStore`, or RNG (all safe under
  single-threaded async, per Key facts).

### 5. Determinism invariant

Parallel execution MUST be result-identical to serial execution. Each run is
independent: its own request, seed, and RNG closure, reading the shared
**immutable** tape. The frozen momentum golden
`sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba` and the
overlay goldens MUST NOT move. Only completion *ordering* may differ; result
hashes and artifacts (content-addressed) are unaffected.

### 6. Observability

Log the configured concurrency and a per-tick count of jobs started / completed,
so it is visible that the pool actually runs runs in parallel.

## Testing

- The pool runs at most `N` jobs concurrently: with a controllable slow fake job,
  assert exactly `N` are in-flight before any completes.
- Claim safety: many concurrent `claimNextQueued` calls on `InMemoryJobStore`
  never hand the same job to two callers, and every queued job is claimed exactly
  once.
- Determinism (the load-bearing test): the same set of jobs drained with
  `WORKER_CONCURRENCY=N` produces the **same result hashes** as drained serially;
  momentum and overlay goldens unchanged.
- `FileArtifactStore` atomic-write regression: concurrent writes of the same
  payload never yield a truncated/torn read.
- `WORKER_CONCURRENCY=1` reproduces serial behavior (one in-flight at a time).

## Scope / non-goals (YAGNI)

Out: worker threads, multi-process workers, Redis/L2, work-stealing, dynamic
auto-tuning of the concurrency limit, per-job priority. These target CPU-bound or
multi-replica scale that is not the current need; (A) leaves room to add a
process-based tier later if a CPU-bound workload emerges.
