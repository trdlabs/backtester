# Backtester throughput scaling — analysis & decision record

**Status:** Decision recorded (2026-07-01) — context for Phase C in `docs/ROADMAP.md`.
**Purpose:** preserve the detailed reasoning behind the scaling roadmap so a future Claude Code session can resume with code-level context instead of reconstructing the discussion.

## Background

`trading-backtester` executes LLM-generated strategy and overlay bundles in a locked-down sandbox because the code is untrusted. The user concern was throughput: a single server can raise `WORKER_CONCURRENCY` or rent more cores, but many users may still wait behind long backtests.

Perplexity's answer correctly identified the high-level direction: move beyond one host, scale workers horizontally, keep sandbox isolation, consider better sandbox runtimes later, and deduplicate identical work. This record captures where that answer matches this repo and where the implementation details change the recommendation.

## Code facts checked in this repo

The current service is already designed around a shared durable queue when Postgres is enabled:

- `apps/backtester/src/jobs/worker.ts`:
  - `drainQueue(deps, concurrency)` uses `runBoundedPool`.
  - every pool slot calls `processNextQueued`, so concurrency is multiple independent queue claims.
  - `runWorkerLoop` is a long-lived loop: drain, reap, idle, repeat.
- `apps/backtester/src/jobs/pg-job-store.ts`:
  - `PgJobStore.claimNextQueued()` uses `FOR UPDATE SKIP LOCKED`.
  - that makes multiple worker processes/Pods safe against the same Pg queue.
  - terminal updates go through guarded `transition(...)` from `running` to terminal status.
- `apps/backtester/src/worker-main.ts`:
  - standalone workers require `DATABASE_URL`; in-memory store is explicitly rejected for multi-process operation.
- `apps/backtester/src/app.ts`:
  - API and worker can be separated with `BACKTESTER_AUTO_WORKER=false` for API processes and `worker-main.ts` for worker processes.
- `apps/backtester/src/engine/sandbox/docker-driver.ts`:
  - Docker sandbox execution preserves the important flags: `--network none`, `--read-only`, tmpfs, memory/cpu/pids limits, `--cap-drop ALL`, `no-new-privileges`, non-root user, no inherited env, and `node --disallow-code-generation-from-strings`.
- `apps/backtester/src/engine/sandbox/sandbox-session.ts`:
  - sandbox sessions are per module+symbol, not one global container for the whole cluster and not one container per hook.
  - capacity must account for `worker_concurrency * symbols_per_run * sandbox_limits`.
- `apps/backtester/src/engine/runner.ts`:
  - `simulateTarget` iterates symbols sequentially and uses shared portfolio state.
  - parallelizing inside a single backtest is not a simple mechanical change; first scale across jobs.
- `apps/backtester/src/jobs/fingerprint.ts`:
  - `requestFingerprint` already normalizes run-affecting inputs and bundle hash.
  - current idempotency is still based on `resumeToken` or `runId`, not global semantic dedup.
- `apps/backtester/migrations/0001_init.sql`:
  - `request_fingerprint` is stored, but it is not a unique result-cache key.

## Assessment of the Perplexity proposal

### Correct direction

- Horizontal scaling is the right first lever. The Pg queue and `FOR UPDATE SKIP LOCKED` are already the right primitive.
- A cluster scheduler is the right production boundary once one machine is no longer enough.
- Stronger sandbox runtimes (gVisor/Kata/Firecracker) are relevant for multi-tenant untrusted code, but they are not the first throughput blocker in this repo.
- Result dedup is likely high leverage because LLM-generated workflows often retry or fan out similar bundles/datasets/params.

### Adjustment for this codebase

Perplexity suggested `KEDA ScaledJob` as the main pattern. For the current code, the better first Kubernetes shape is:

1. API as a long-lived Deployment with `BACKTESTER_AUTO_WORKER=false`.
2. Worker as a long-lived Deployment running `worker-main.ts`.
3. KEDA `ScaledObject` on queued-job depth to scale the worker Deployment.

Reason: the current worker process is intentionally long-lived (`runWorkerLoop`). `ScaledJob` fits only after adding a worker-once mode that claims/drains a bounded batch and exits. Without that, KEDA would create Jobs whose Pods remain idle after the queue empties, which is the wrong lifecycle.

Perplexity also framed Docker cold start as a major issue. In this repo the overlay/strategy sandbox path keeps a session per module+symbol and reuses it across hooks for that symbol. Docker startup still matters, but the immediate throughput ceiling is cluster/node capacity, shared storage, Docker daemon pressure, and admission control, not per-hook startup.

## Settled priority order

### 1. Horizontal worker deployment

Split API and worker processes:

- API: `BACKTESTER_AUTO_WORKER=false`.
- Workers: `worker-main.ts`, shared `DATABASE_URL`, unique `WORKER_ID`, tuned `WORKER_CONCURRENCY`.
- Keep `InMemoryJobStore` only for tests/dev.

Prefer many modest workers over one large worker. Start with `WORKER_CONCURRENCY=1` or `2` per Pod and scale Pod count.

### 2. Shared bundle and artifact storage

Before workers span multiple nodes, host-local file stores must become cluster-visible:

- bundle store: submitted module bundles must be readable by any worker that claims the job.
- artifact store: result artifacts must be readable by API/result endpoints regardless of which worker wrote them.

Good first options: S3/MinIO object store, NFS/CSI volume, or another durable content-addressed store. Preserve content-addressing and canonical JSON semantics.

### 3. KEDA ScaledObject, not ScaledJob yet

Use KEDA to scale the long-lived worker Deployment from Pg queue depth.

Add `ScaledJob` only after implementing a deliberate `worker-once` command that:

- claims one or a bounded number of jobs,
- exits when done or when the queue is empty,
- renews leases while running,
- preserves reaping/outbox semantics.

### 4. Tenant fairness and quotas

Before opening the service to many users, add admission and fairness controls:

- per-tenant/user queued-job limit,
- per-tenant/user running-job limit,
- cancellation/expiry policy,
- metrics for queue wait time by tenant,
- possibly priority tiers later.

The global Pg queue can remain shared, but scheduling/admission must prevent one tenant from monopolizing worker capacity.

### 5. Fingerprint-based dedup and in-flight coalescing

Use the existing `requestFingerprint` as the run-affecting input key, with extra version dimensions:

- request fingerprint,
- bundle hash,
- dataset fingerprint or stable dataset version,
- engine/runtime version,
- sandbox runtime/policy version if it can affect deterministic output.

Two forms matter:

- completed result cache: skip compute when an equivalent result already exists;
- in-flight coalescing: if equivalent work is already running, link/wait instead of launching duplicate compute.

Caveat: current outcomes/result hashes include `runId` in some paths. A cache design must either:

- materialize a per-run result from a runId-normalized compute template, or
- consciously change the result hash contract with golden tests.

Do not blindly return another run's `result_hash` for a different `runId`.

### 6. Stronger sandbox runtime later

Evaluate gVisor/Kata/Firecracker after the horizontal Docker path works under real load.

Any replacement must preserve:

- no network/secrets,
- read-only root/mounts where applicable,
- cpu/memory/pids/wall-time enforcement,
- stable timeout/OOM/crash taxonomy,
- deterministic cleanup,
- IPC behavior and validation.

Treat this as a sandbox-driver abstraction project, not a one-file swap.

### 7. Temporal later, for workflow orchestration

Temporal is not the first answer for raw backtest throughput. It becomes useful when the product workflow is durable and multi-step:

`generate strategy -> validate -> backtest -> evaluate -> re-prompt -> evidence -> publish`

For today's core queue, Pg + leases + reaping + outbox is an adequate job lifecycle.

## Explicit non-goals for the first scaling pass

- Do not weaken sandbox restrictions to gain throughput.
- Do not parallelize a single backtest across symbols until portfolio semantics are redesigned.
- Do not introduce `ScaledJob` without worker-once lifecycle.
- Do not introduce Firecracker or Temporal before proving the simpler horizontal worker path.
- Do not implement dedup by ignoring `runId` in existing result hashes without a contract decision and golden updates.

## Roadmap linkage

This document backs `docs/ROADMAP.md` Phase C: throughput and multi-tenant scaling.

