# Horizontal worker processes (multi-process sweep core) — Design

**Date:** 2026-06-24
**Status:** Approved in principle (brainstorming), pending spec review
**Branch:** `feat/horizontal-workers`
**Base:** `main` @ `488ce54` (async-IPC merged)

## Problem

A parameter-grid sweep is N independent backtests over the *same* data slice
(e.g. param-A 0→1 step 0.1 × param-B 10→20 step 1 = 11×11 = 121 runs). Today the
queue is drained by a single in-process worker tick (`app.ts` `setInterval` →
`drainQueue` → `runBoundedPool`). The in-process async pool (perf #2 + async-IPC)
overlaps runs only within one Node thread and is bounded by host cores + the
single-threaded host JS — measured **~1.74×**. For 121 runs over months of
history (~2.5 min/run → ~5 h serial) that is far too slow.

The work is CPU-bound (each sandbox container computes per-bar; the host does
per-bar JS), so the real lever is **using all CPU cores / machines** — true
horizontal parallelism across OS processes, each draining the shared queue.

## Approach (and why)

**Horizontal worker processes against a shared Postgres queue.** The claim seam is
already multi-process-safe: `PgJobStore.claimNextQueued` uses
`FOR UPDATE SKIP LOCKED`. Run **1 API node + M worker nodes** against one
`DATABASE_URL`; the sweep enqueues N jobs; M workers drain them concurrently,
each using the in-process async pool internally. Throughput scales ~linearly with
total cores (efficiency ~0.7–0.85). M processes ≈ host threads is what scales
host-side JS; `WORKER_CONCURRENCY` per process is a sub-multiplier.

Rejected alternatives: `node:cluster` (one parent forks workers — shares no heap
benefit over separate processes, more coupling); worker threads (awkward tape
sharing; host-thread parallelism is better served by separate processes);
keeping the single in-process worker (the measured ~1.74× ceiling is the problem).

## Key facts (grounded in code, 2026-06-24)

- `index.ts` starts the HTTP server **and** the worker tick in one process;
  `app.ts:110` `drain = drainQueue(workerDeps, config.workerConcurrency)`,
  `app.ts:116` `tick` on a `setInterval`, gated by `config.autoWorker`.
- Jobs are submitted one at a time: `POST /v1/runs` → `submitRun`
  (`jobs/submit.ts:106`). No batch/sweep/grid endpoint (deferred — sub-project 3).
- `PgJobStore.claimNextQueued` uses `FOR UPDATE SKIP LOCKED` (atomic across
  processes). `InMemoryJobStore.transition` is a synchronous CAS.
- Deadlines: a job gets `runDeadlineMs` (= now + `runTimeoutMs`) on claim;
  `reapAndPublish` (`jobs/completion.ts:111`) → `store.reapDeadlines(now)` marks
  past-deadline `running`/`queued` jobs `timed_out`/`expired` (no requeue today).
- `JobStore` interface (`jobs/job-store.ts`): `claimNextQueued`, `transition`
  (CAS), `reapDeadlines`. `lifecycle.ts` ALLOWED transitions:
  `queued→running`, `running→{completed,failed,canceled,timed_out}`.
- Multi-process **requires** PgJobStore (InMemory is per-process). The worker
  entrypoint fails fast without `DATABASE_URL`.
- Each worker keeps its own L1 tape cache (perf #1). The cache key
  (`tape-cache.ts`) is the DATA SLICE only — `datasetRef | timeframe | from | to |
  symbols(sorted)` — NOT strategy/params/overlay, so any runs over the same period
  (even different strategies/params) share the tape; and `getOrBuild` caches the
  in-flight Promise, so N concurrent same-key runs in one process trigger exactly
  ONE materialization (no N-build race under the now-real async overlap). Sharing
  it ACROSS processes (L2) is sub-project 2 — out of scope here; M worker
  processes each materialize the sweep's one tape once (M builds total, not 1 and
  not N).

## Design

### 1. Two roles, one codebase

- **API node** — the existing service with `autoWorker=false`: serves
  submit/status/result/artifacts only, does not drain.
- **Worker node** — a NEW entrypoint `src/worker-main.ts`: drains the shared
  queue, no HTTP. Builds the same `WorkerDeps` from config as `app.ts` does
  (dataPort, artifactStore, bundleStore, sandbox, overlaySandbox), minus the
  Fastify server. Fails fast if `DATABASE_URL` is unset.
- Run `1 API + M workers` against one Postgres. Locally: launch M `worker-main`
  processes; later: M pod replicas of the same image (manifests are a deploy
  concern, out of scope).

### 2. Worker loop & shutdown

A long-lived loop: claim next queued (SKIP LOCKED) → run via the existing
`processNextQueued` + `runBoundedPool` (so a single worker still overlaps
`WORKER_CONCURRENCY` runs internally). When the queue is empty, poll on a small
fixed interval (`WORKER_POLL_MS`, default 500 ms) and resume when work appears.
Graceful shutdown (SIGINT/SIGTERM): stop claiming, await in-flight runs, release
their leases, exit 0 — mirrors `index.ts`'s existing shutdown handlers.

### 3. Lease + crash recovery (the reliability core)

New job fields (Postgres columns + a forward migration; mirrored on
`InMemoryJobStore`): `leased_by: string | null`, `lease_expires_at: number | null`,
`attempts: number` (default 0).

- **Claim:** the claim sets `leased_by = WORKER_ID`,
  `lease_expires_at = now + WORKER_LEASE_TTL_MS`, `attempts += 1`, atomically with
  the `queued→running` transition (one statement; the PG path folds it into the
  existing SKIP LOCKED CTE).
- **Heartbeat:** each worker renews `lease_expires_at` for ALL its in-flight jobs
  every `WORKER_HEARTBEAT_MS` (default `WORKER_LEASE_TTL_MS / 3`) via
  `store.renewLease(runIds, workerId, now + WORKER_LEASE_TTL_MS)`.
- **Reaper (requeue):** `reapDeadlines` is extended: a `running` job whose
  `lease_expires_at < now` is **requeued** (`running→queued`, clear lease) when
  `attempts < WORKER_MAX_ATTEMPTS` (default 3), else marked `failed` (poison).
  The reaper is idempotent and SKIP-LOCKED-safe, so it runs in every worker on a
  timer (no dependency on the API node being up). Pre-existing queue/run-deadline
  reaping is preserved.
- **At-least-once safety:** a slow-but-alive (zombie) worker whose lease was
  reclaimed must not corrupt the result. Completion/terminal transitions take an
  owner guard: the `running→{completed,…}` CAS additionally requires
  `leased_by = WORKER_ID`. If the lease was reassigned, the zombie's transition
  fails and it discards its result. Runs are deterministic + content-addressed, so
  a duplicate run produces an identical `resultHash` — at-least-once is safe.
- **`new transition()` semantics:** add `'running'→'queued'` to the allowed
  lifecycle (requeue). Keep all existing transitions.

Config (env → AppConfig): `WORKER_ID` (default `${hostname}:${pid}`),
`WORKER_LEASE_TTL_MS` (default 30_000), `WORKER_HEARTBEAT_MS` (default 10_000),
`WORKER_MAX_ATTEMPTS` (default 3), `WORKER_POLL_MS` (default 500). All clamped to
sane minimums (lease TTL ≥ 3× heartbeat).

### 4. JobStore interface changes

Extend `JobStore` (both impls):
- `claimNextQueued(nowMs, lease: { workerId, ttlMs })` → sets lease + attempts on
  claim (or an overload; the existing single-arg callers in tests get a default
  no-lease behavior that still works for single-process).
- `renewLease(runIds: string[], workerId: string, untilMs: number): Promise<void>`.
- `reapDeadlines(nowMs, opts?: { maxAttempts })` → also requeues expired-lease
  `running` jobs under the attempts cap (returns the rows it changed, tagged
  requeued vs failed vs timed_out).
- terminal `transition(...)` gains an optional `expectLeasedBy` guard.

PgJobStore: a forward-only migration adds the three columns (defaults
backfill existing rows: `leased_by=NULL`, `lease_expires_at=NULL`, `attempts=0`);
the claim CTE, a `renewLease` UPDATE, and the reap UPDATE implement the above.
InMemoryJobStore: the same semantics in-process (single worker → lease rarely
expires; present for interface parity + tests).

### 5. API node wiring

`index.ts` / config: an API node runs with `autoWorker=false` (no drain tick). It
keeps submit/status/result/artifacts. The reaper does NOT need to live in the API
node (workers run it); the API node may still run it harmlessly (idempotent).
`buildApp` is unchanged except that `autoWorker=false` simply skips the tick (it
already gates on `config.autoWorker`).

## Dependency / sequencing note

This core is independently shippable and testable, BUT the headline payoff —
parallelizing a months-of-history sweep — is **blocked by `wallTimeMsPerSession`
(30 s)**: a ~2.5-min run times out regardless of how many workers run it. Raising
that budget is **sub-project 4** and is the recommended immediate follow-up (or
predecessor). This spec does not change the session budget. The core is still
valuable on its own for shorter-history sweeps and is the foundation every other
sub-project builds on.

## Throughput expectation (documented for ops)

Sweep wall-clock ≈ `ceil(N / C) × per_run_time`, where `C` ≈ `usable_cores ×
efficiency` (efficiency ~0.7–0.85; lower on small boxes that co-locate API +
Postgres). Guidance: set **M (worker processes) ≈ cores**, `WORKER_CONCURRENCY`
modest (2–4); leave ~1 core for API/Postgres/OS. RAM budget: `C ×
sandbox.memoryMb` for concurrent containers. Example: 121 runs × 2.5 min ≈ 5 h
serial → ~50 min on 8 cores, ~25 min on 16 cores.

## Testing

- **Lease unit (InMemory + Docker-gated PG):** claim sets `leased_by` /
  `lease_expires_at` / `attempts`; `renewLease` extends; `reapDeadlines` requeues
  an expired-lease `running` job when `attempts < max` and fails it (poison) at
  `attempts ≥ max`; pre-existing queue/run-deadline reaping still works.
- **Concurrent claim (extends `concurrent-claim.test.ts`):** many concurrent
  claimers never double-claim; every job claimed exactly once; each carries a
  lease.
- **Crash recovery:** a worker that claims then never heartbeats → its job is
  requeued and completed by a second worker; final `resultHash` is correct.
- **At-least-once / zombie:** a worker whose lease was reclaimed mid-run has its
  terminal transition rejected by the owner guard; the second worker's identical
  result stands.
- **Determinism across workers:** a set of jobs drained by M simulated workers
  yields the SAME per-job result hashes as a single-worker drain; momentum +
  overlay goldens unchanged.
- **Graceful shutdown:** SIGTERM mid-run → in-flight finishes, lease released, no
  orphaned `running` row.
- **Fail-fast:** worker entrypoint without `DATABASE_URL` exits non-zero with a
  clear message.

## Horizontal scale-out (multi-machine) — ready by construction

This design scales across machines without rework, because the only coordination
point is the shared Postgres queue:

- **Claim is cross-host atomic.** `FOR UPDATE SKIP LOCKED` is a database-level
  lock, so any number of worker processes on any number of machines pointed at the
  same `DATABASE_URL` never double-claim. N× 32-core servers = run ~cores workers
  per box against one Postgres.
- **Lease/heartbeat/requeue is cross-host.** `WORKER_ID = ${hostname}:${pid}` is
  globally unique, so a dead machine's orphaned `running` jobs are requeued by the
  reaper exactly like a dead process. No machine affinity is assumed anywhere.

Cross-machine deltas — all already behind existing seams, so they are
"add an implementation", NOT a redesign (and remain out of scope here / future
sub-projects):

- **Artifact store** (`ArtifactStore` seam; today `FileArtifactStore` = local
  disk): MUST be shared/networked (S3-like, or DB-backed) so the API node can
  serve artifacts a remote worker wrote. This is the main multi-machine
  prerequisite — a new `ArtifactStore` impl behind the existing interface.
- **Bundle store** (`BundleStore` seam; today `FileBundleStore` = local disk):
  same — a worker on another machine must read a submitted bundle. New impl behind
  the seam.
- **Data access** (`BacktesterDataPort` seam): `HttpDataPort`/`RowsDataPort` are
  already networked; only `FixtureDataPort` is local-disk.
- **L2 tape cache** (sub-project 2): without it each of the ~N workers materializes
  the sweep's tape once; an L2 (Redis/object store) shares one materialization.
  Optimization, not a correctness blocker.
- Ops: Postgres reachable from all hosts; connection-pool sizing for many workers;
  each worker host runs Docker (sandbox containers are local to the worker).

The core in this spec assumes nothing single-machine; multi-machine is a deploy +
seam-implementation exercise on top, not a rewrite.

## Scope / non-goals (YAGNI)

Out: L2 shared tape cache (sub-project 2), sweep/grid submission + aggregation API
(sub-project 3), raising `wallTimeMsPerSession` (sub-project 4 — but called out as
the blocking dependency for long history), k8s/compose manifests + a worker
Dockerfile (deploy concern; the entrypoint is pod-ready), autoscaling,
work-stealing beyond `SKIP LOCKED`, priority queues.
