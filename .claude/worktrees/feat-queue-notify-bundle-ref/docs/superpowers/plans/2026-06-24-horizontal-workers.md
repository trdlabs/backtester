# Horizontal Worker Processes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run M dedicated worker processes draining the shared Postgres queue so independent backtests (and sweeps) execute in parallel across cores/machines, with lease + heartbeat + auto-requeue crash recovery.

**Architecture:** A new `worker-main.ts` entrypoint runs a drain loop (reusing `processNextQueued` + the perf-#2 pool) plus a heartbeat that renews its lease on in-flight jobs; the existing service becomes an API node that drains only when `autoWorker` is set. The claim is already multi-process-safe (`FOR UPDATE SKIP LOCKED`); we add a per-job lease (`leased_by` / `lease_expires_at` / `attempts`) so an expired lease re-queues the job (bounded retries), and owner-guarded terminal transitions make at-least-once safe.

**Tech Stack:** TypeScript (strict, ESM with `.js` import extensions), Node ≥22, Vitest, pnpm, Postgres (`pg`), Docker (sandbox tests).

## Global Constraints

- ESM imports MUST use the `.js` extension on relative paths.
- Multi-process mode REQUIRES `PgJobStore` (`DATABASE_URL` set); `InMemoryJobStore` is per-process. The worker entrypoint fails fast (exit non-zero) without `DATABASE_URL`.
- Determinism invariant: a job set drained across M workers MUST produce the SAME per-job `resultHash` as a single-worker drain. Momentum golden `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba` and overlay goldens MUST NOT move.
- At-least-once safety: a duplicate run is acceptable because results are deterministic + content-addressed; a zombie worker's terminal transition MUST be rejected once its lease is reclaimed (owner guard).
- `InMemoryJobStore` and `PgJobStore` MUST stay behaviorally equivalent (mirror every lease change in both).
- Migrations are forward-only `apps/backtester/migrations/NNNN_*.sql`, applied lexically by `src/db/migrate.ts`; use `ADD COLUMN IF NOT EXISTS`.
- Defaults: `WORKER_LEASE_TTL_MS=30000`, `WORKER_HEARTBEAT_MS=10000`, `WORKER_MAX_ATTEMPTS=3`, `WORKER_POLL_MS=500`, `WORKER_ID=${hostname}:${pid}`. Clamp `WORKER_LEASE_TTL_MS >= 3 * WORKER_HEARTBEAT_MS`.
- Run `pnpm typecheck` and `pnpm test` from the repo root.

---

## File Structure

- **Create** `apps/backtester/migrations/0003_worker_lease.sql` — add lease columns.
- **Modify** `apps/backtester/src/jobs/lifecycle.ts` — allow `running→queued` (requeue).
- **Modify** `apps/backtester/src/jobs/job-store.ts` — `JobRow` lease fields; `JobStore` interface (lease-aware `claimNextQueued`, new `renewLease`, owner-guarded `transition`, requeue in `reapDeadlines`); `InMemoryJobStore` impl.
- **Modify** `apps/backtester/src/jobs/pg-job-store.ts` — `JobDbRow` + `rowToJob` lease fields; SQL for claim/renew/transition/reap.
- **Modify** `apps/backtester/src/config.ts` — `WORKER_*` knobs on `AppConfig` + `loadConfig`.
- **Modify** `apps/backtester/src/jobs/worker.ts` — `WorkerDeps.lease`; thread lease through `processNextQueued`; new exported `runWorkerLoop`.
- **Create** `apps/backtester/src/worker-main.ts` — worker-node entrypoint (fail-fast, wiring, signals).
- **Modify** `apps/backtester/src/index.ts` — gate `startWorker()` on `config.autoWorker`.
- **Modify** `apps/backtester/package.json` — `worker` start script.
- **Tests:** `apps/backtester/test/worker-lease.test.ts` (store lease unit, InMemory + Docker/PG-gated), extend `apps/backtester/test/concurrent-claim.test.ts`, `apps/backtester/test/worker-loop.test.ts` (loop + heartbeat + crash recovery + determinism-across-workers).

---

## Task 1: Lease columns + lifecycle requeue

Foundational schema + types only; no behavior wiring. Compiles, existing tests stay green.

**Files:**
- Create: `apps/backtester/migrations/0003_worker_lease.sql`
- Modify: `apps/backtester/src/jobs/lifecycle.ts`
- Modify: `apps/backtester/src/jobs/job-store.ts` (`JobRow` only)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts` (`JobDbRow` + `rowToJob` only)
- Test: `apps/backtester/test/lifecycle.test.ts` (create if absent) or add to an existing lifecycle test

**Interfaces:**
- Produces: `JobRow.leasedBy?: string`, `JobRow.leaseExpiresAt?: number`, `JobRow.attempts: number`; `canTransition('running','queued') === true`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/jobs/lifecycle.js';

describe('lifecycle — requeue', () => {
  it('allows running -> queued (lease requeue)', () => {
    expect(canTransition('running', 'queued')).toBe(true);
  });
  it('still forbids terminal -> queued', () => {
    expect(canTransition('completed', 'queued')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/lifecycle.test.ts`
Expected: FAIL — `running→queued` currently not allowed.

- [ ] **Step 3: Allow the requeue transition**

In `apps/backtester/src/jobs/lifecycle.ts`, change the `running` entry of `ALLOWED_TRANSITIONS`:

```ts
  running: ['completed', 'failed', 'canceled', 'timed_out', 'queued'],
```

- [ ] **Step 4: Add lease fields to `JobRow`**

In `apps/backtester/src/jobs/job-store.ts`, add to the `JobRow` interface (after `runDeadlineMs?`):

```ts
  /** Worker that currently holds this job (multi-process lease); absent when unclaimed. */
  leasedBy?: string;
  /** Epoch ms after which the lease is stale and the job may be requeued. */
  leaseExpiresAt?: number;
  /** Number of times this job has been claimed (for bounded requeue / poison detection). */
  attempts: number;
```

In `InMemoryJobStore.insertOrGet`, the new row literal must set `attempts: 0` (it spreads `...job` which has no `attempts`):

```ts
    const row: JobRow = {
      ...job,
      status: 'accepted',
      attempts: 0,
      timeline: [{ status: 'accepted', atMs: job.acceptedAtMs }],
    };
```

- [ ] **Step 5: Add the migration**

Create `apps/backtester/migrations/0003_worker_lease.sql`:

```sql
-- Horizontal workers — per-job lease for multi-process crash recovery.
-- leased_by: worker holding the job; lease_expires_at: stale-after epoch ms; attempts: claim count.
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS leased_by TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 6: Map the columns in `pg-job-store.ts`**

In `apps/backtester/src/jobs/pg-job-store.ts`, add to the `JobDbRow` interface:

```ts
  leased_by: string | null;
  lease_expires_at: string | null;
  attempts: string | number;
```

And in `rowToJob`, add to the returned object (alongside `runDeadlineMs`):

```ts
    leasedBy: str(r.leased_by),
    leaseExpiresAt: num(r.lease_expires_at),
    attempts: Number(r.attempts ?? 0),
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm exec vitest run apps/backtester/test/lifecycle.test.ts && pnpm typecheck`
Expected: lifecycle test PASS (2/2); typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/migrations/0003_worker_lease.sql apps/backtester/src/jobs/lifecycle.ts apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/lifecycle.test.ts
git commit -m "feat(jobs): lease columns + running->queued requeue transition"
```

---

## Task 2: Lease-aware claim + renewLease + owner-guarded transition

Wire the lease into claim/renew/transition on both stores. This is the concurrency core.

**Files:**
- Modify: `apps/backtester/src/jobs/job-store.ts` (`JobStore` interface + `InMemoryJobStore`)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts`
- Test: `apps/backtester/test/worker-lease.test.ts`; extend `apps/backtester/test/concurrent-claim.test.ts`

**Interfaces:**
- Consumes: `JobRow` lease fields (Task 1).
- Produces:
  - `claimNextQueued(nowMs: number, lease?: { workerId: string; ttlMs: number }): Promise<JobRow | undefined>` — when `lease` is given, sets `leasedBy`, `leaseExpiresAt = nowMs + ttlMs`, `attempts += 1` atomically with `queued→running`.
  - `renewLease(workerId: string, untilMs: number): Promise<void>` — sets `lease_expires_at = untilMs` for every `running` job currently `leased_by = workerId`.
  - `transition(runId, from, to, patch, expectLeasedBy?: string): Promise<boolean>` — when `expectLeasedBy` is set, the CAS also requires `leased_by = expectLeasedBy`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/worker-lease.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';

function newJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds',
    runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
  };
}
async function enqueue(store: InMemoryJobStore, runId: string) {
  await store.insertOrGet(newJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
}

describe('store lease', () => {
  it('claim with a lease sets leasedBy/leaseExpiresAt/attempts', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    const claimed = await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    expect(claimed?.runId).toBe('r1');
    const row = await store.get('r1');
    expect(row?.leasedBy).toBe('w1');
    expect(row?.leaseExpiresAt).toBe(35_000);
    expect(row?.attempts).toBe(1);
  });

  it('renewLease extends only this worker\'s running jobs', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    await store.renewLease('w1', 99_000);
    expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);
    await store.renewLease('w2', 123_000); // different worker — no-op
    expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);
  });

  it('owner-guarded transition rejects a non-owner', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    const wrong = await store.transition('r1', 'running', 'completed', { atMs: 6000 }, 'w2');
    expect(wrong).toBe(false);
    const right = await store.transition('r1', 'running', 'completed', { atMs: 6000 }, 'w1');
    expect(right).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease.test.ts`
Expected: FAIL — `claimNextQueued` ignores the lease arg; `renewLease` undefined; `transition` ignores `expectLeasedBy`.

- [ ] **Step 3: Update the `JobStore` interface**

In `apps/backtester/src/jobs/job-store.ts`, change the interface signatures:

```ts
  transition(runId: string, from: RunStatus, to: RunStatus, patch: JobRowPatch, expectLeasedBy?: string): Promise<boolean>;
  claimNextQueued(nowMs: number, lease?: { workerId: string; ttlMs: number }): Promise<JobRow | undefined>;
  renewLease(workerId: string, untilMs: number): Promise<void>;
```

- [ ] **Step 4: Implement in `InMemoryJobStore`**

In `apps/backtester/src/jobs/job-store.ts`, update `transition` (add the guard at the top check) and `claimNextQueued`, and add `renewLease`:

```ts
  async transition(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    patch: JobRowPatch,
    expectLeasedBy?: string,
  ): Promise<boolean> {
    const job = this.jobs.get(runId);
    if (!job || job.status !== from || !canTransition(from, to)) return false;
    if (expectLeasedBy !== undefined && job.leasedBy !== expectLeasedBy) return false;
    job.status = to;
    // ... existing patch assignments UNCHANGED ...
    job.timeline.push({ status: to, atMs: patch.atMs });
    return true;
  }

  async claimNextQueued(
    nowMs: number,
    lease?: { workerId: string; ttlMs: number },
  ): Promise<JobRow | undefined> {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) =>
        (a.queuedAtMs ?? a.acceptedAtMs) - (b.queuedAtMs ?? b.acceptedAtMs) ||
        (a.runId < b.runId ? -1 : 1),
      );
    const next = queued[0];
    if (!next) return undefined;
    const ok = await this.transition(next.runId, 'queued', 'running', {
      atMs: nowMs,
      startedAtMs: nowMs,
      lastActivityMs: nowMs,
      runDeadlineMs: nowMs + next.runTimeoutMs,
    });
    if (!ok) return undefined;
    if (lease !== undefined) {
      next.leasedBy = lease.workerId;
      next.leaseExpiresAt = nowMs + lease.ttlMs;
      next.attempts += 1;
    }
    return next;
  }

  async renewLease(workerId: string, untilMs: number): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.leasedBy === workerId) job.leaseExpiresAt = untilMs;
    }
  }
```

(Note: `next` is the same object reference held in the map, so mutating it after `transition` persists.)

- [ ] **Step 5: Implement in `PgJobStore`**

In `apps/backtester/src/jobs/pg-job-store.ts`:

Add the owner guard to `transition` — add the param and an extra WHERE clause:

```ts
  async transition(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    patch: JobRowPatch,
    expectLeasedBy?: string,
  ): Promise<boolean> {
    if (!canTransition(from, to)) return false;
    const entry: RunTimelineEntry[] = [{ status: to, atMs: patch.atMs }];
    const r = await this.pool.query(
      `UPDATE backtest_job SET
         status = $1,
         queued_at_ms           = COALESCE($4, queued_at_ms),
         started_at_ms          = COALESCE($5, started_at_ms),
         terminal_at_ms         = COALESCE($6, terminal_at_ms),
         last_activity_ms       = COALESCE($7, last_activity_ms),
         run_deadline_ms        = COALESCE($8, run_deadline_ms),
         result_summary_json    = COALESCE($9::jsonb, result_summary_json),
         result_hash            = COALESCE($10, result_hash),
         artifact_manifest_json = COALESCE($11::jsonb, artifact_manifest_json),
         dataset_fingerprint    = COALESCE($12, dataset_fingerprint),
         terminal_code          = COALESCE($13, terminal_code),
         timeline_json          = timeline_json || $14::jsonb
       WHERE run_id = $2 AND status = $3
         AND ($15::text IS NULL OR leased_by = $15)`,
      [
        to, runId, from,
        patch.queuedAtMs ?? null, patch.startedAtMs ?? null, patch.terminalAtMs ?? null,
        patch.lastActivityMs ?? null, patch.runDeadlineMs ?? null,
        patch.resultSummary ? JSON.stringify(patch.resultSummary) : null,
        patch.resultHash ?? null,
        patch.artifactManifest ? JSON.stringify(patch.artifactManifest) : null,
        patch.datasetFingerprint ?? null, patch.terminalCode ?? null,
        JSON.stringify(entry),
        expectLeasedBy ?? null,
      ],
    );
    return r.rowCount === 1;
  }
```

Update `claimNextQueued` to set the lease in the CTE UPDATE:

```ts
  async claimNextQueued(
    nowMs: number,
    lease?: { workerId: string; ttlMs: number },
  ): Promise<JobRow | undefined> {
    const entry: RunTimelineEntry[] = [{ status: 'running', atMs: nowMs }];
    const r = await this.pool.query<JobDbRow>(
      `WITH next AS (
         SELECT run_id FROM backtest_job
         WHERE status = 'queued'
         ORDER BY COALESCE(queued_at_ms, accepted_at_ms) ASC, run_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE backtest_job j SET
         status = 'running',
         started_at_ms = $1::bigint,
         last_activity_ms = $1::bigint,
         run_deadline_ms = $1::bigint + j.run_timeout_ms,
         leased_by = $3,
         lease_expires_at = CASE WHEN $3::text IS NULL THEN NULL ELSE $1::bigint + $4::bigint END,
         attempts = j.attempts + 1,
         timeline_json = j.timeline_json || $2::jsonb
       FROM next WHERE j.run_id = next.run_id
       RETURNING j.*`,
      [nowMs, JSON.stringify(entry), lease?.workerId ?? null, lease?.ttlMs ?? 0],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }
```

Add `renewLease`:

```ts
  async renewLease(workerId: string, untilMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_job SET lease_expires_at = $2::bigint
       WHERE status = 'running' AND leased_by = $1`,
      [workerId, untilMs],
    );
  }
```

- [ ] **Step 6: Extend the concurrent-claim test for leases**

Read `apps/backtester/test/concurrent-claim.test.ts` to learn its existing structure (it covers both stores via a factory; one case is Docker/PG-gated). Add ONE assertion to the existing "no double-claim" case: after the concurrent claims, every claimed row has a non-null `leasedBy` matching the claimer's workerId, and each `attempts === 1`. Use the SAME store factory the file already uses; pass `{ workerId: 'w<i>', ttlMs: 30_000 }` to each concurrent `claimNextQueued`. (Keep the existing no-double-claim assertions.)

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease.test.ts apps/backtester/test/concurrent-claim.test.ts && pnpm typecheck`
Expected: worker-lease 3/3 PASS; concurrent-claim PASS (PG case runs if Docker present, else skips); typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/worker-lease.test.ts apps/backtester/test/concurrent-claim.test.ts
git commit -m "feat(jobs): lease-aware claim + renewLease + owner-guarded transition"
```

---

## Task 3: Lease-requeue in reapDeadlines

Expired-lease `running` jobs are requeued (bounded by attempts) or failed (poison). Existing queue/run-deadline timeouts are preserved. Requeued rows are NOT returned (non-terminal → nothing to publish); only terminal rows are returned.

**Files:**
- Modify: `apps/backtester/src/jobs/job-store.ts` (`JobStore.reapDeadlines` signature + `InMemoryJobStore`)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts`
- Test: extend `apps/backtester/test/worker-lease.test.ts`

**Interfaces:**
- Consumes: lease fields + `attempts` (Task 1/2).
- Produces: `reapDeadlines(nowMs: number, opts?: { leaseMaxAttempts?: number }): Promise<JobRow[]>` — requeues expired-lease `running` jobs with `attempts < leaseMaxAttempts` (clears `leasedBy`/`leaseExpiresAt`), fails (terminal `failed`, code `lease_expired`) those with `attempts >= leaseMaxAttempts`; still expires/times-out queue/run-deadline misses. Returns only the terminal rows. `leaseMaxAttempts` default `3`.

- [ ] **Step 1: Write the failing test**

Append to `apps/backtester/test/worker-lease.test.ts`:

```ts
describe('store lease — reap/requeue', () => {
  it('requeues an expired-lease running job under the attempts cap', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 1000 }); // lease expires at 6000
    const reaped = await store.reapDeadlines(10_000, { leaseMaxAttempts: 3 });
    expect(reaped).toEqual([]); // requeue is non-terminal → not returned
    const row = await store.get('r1');
    expect(row?.status).toBe('queued');
    expect(row?.leasedBy).toBeUndefined();
    expect(row?.attempts).toBe(1); // attempts is NOT reset; next claim makes it 2
  });

  it('fails (poison) an expired-lease job at the attempts cap', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    // claim 3 times (cap=3): each claim increments attempts; re-queue between claims
    for (let i = 0; i < 3; i += 1) {
      await store.claimNextQueued(5000 + i, { workerId: 'w1', ttlMs: 500 });
      if (i < 2) await store.reapDeadlines(10_000 + i, { leaseMaxAttempts: 3 });
    }
    const reaped = await store.reapDeadlines(20_000, { leaseMaxAttempts: 3 });
    expect(reaped.map((r) => r.runId)).toContain('r1');
    const row = await store.get('r1');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('lease_expired');
  });

  it('leaves a healthy (unexpired-lease) running job untouched', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 }); // expires 35000
    await store.reapDeadlines(10_000, { leaseMaxAttempts: 3 });
    expect((await store.get('r1'))?.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease.test.ts`
Expected: FAIL — `reapDeadlines` ignores leases.

- [ ] **Step 3: Implement in `InMemoryJobStore`**

In `apps/backtester/src/jobs/job-store.ts`, replace `reapDeadlines` with:

```ts
  async reapDeadlines(nowMs: number, opts?: { leaseMaxAttempts?: number }): Promise<JobRow[]> {
    const maxAttempts = opts?.leaseMaxAttempts ?? 3;
    const reaped: JobRow[] = [];
    for (const job of this.jobs.values()) {
      if (isTerminal(job.status)) continue;
      if (
        job.status === 'queued' &&
        job.queueDeadlineMs !== undefined &&
        nowMs > job.queueDeadlineMs
      ) {
        if (await this.transition(job.runId, 'queued', 'expired', {
          atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'queue_deadline_exceeded',
        })) reaped.push(job);
      } else if (job.status === 'running') {
        const leaseStale = job.leaseExpiresAt !== undefined && nowMs > job.leaseExpiresAt;
        const runStale = job.runDeadlineMs !== undefined && nowMs > job.runDeadlineMs;
        if (leaseStale && job.attempts >= maxAttempts) {
          if (await this.transition(job.runId, 'running', 'failed', {
            atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'lease_expired',
          })) reaped.push(job);
        } else if (leaseStale) {
          // requeue (non-terminal) — clear the lease so a fresh worker can claim it
          if (await this.transition(job.runId, 'running', 'queued', { atMs: nowMs, queuedAtMs: nowMs })) {
            job.leasedBy = undefined;
            job.leaseExpiresAt = undefined;
          }
        } else if (runStale) {
          if (await this.transition(job.runId, 'running', 'timed_out', {
            atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'run_deadline_exceeded',
          })) reaped.push(job);
        }
      }
    }
    return reaped;
  }
```

- [ ] **Step 4: Implement in `PgJobStore`**

In `apps/backtester/src/jobs/pg-job-store.ts`, replace `reapDeadlines` with (queue-expire and run-timeout queries UNCHANGED; add a requeue UPDATE and a poison UPDATE, ordered poison-before-requeue so a capped job fails rather than loops):

```ts
  async reapDeadlines(nowMs: number, opts?: { leaseMaxAttempts?: number }): Promise<JobRow[]> {
    const maxAttempts = opts?.leaseMaxAttempts ?? 3;
    const expired = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'expired', terminal_at_ms = $1::bigint, terminal_code = 'queue_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'queued' AND queue_deadline_ms IS NOT NULL AND $1::bigint > queue_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'expired', atMs: nowMs }])],
    );
    // Poison: expired-lease running jobs at/over the attempts cap → terminal failure.
    const poisoned = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'failed', terminal_at_ms = $1::bigint, terminal_code = 'lease_expired',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND lease_expires_at IS NOT NULL
         AND $1::bigint > lease_expires_at AND attempts >= $3
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'failed', atMs: nowMs }]), maxAttempts],
    );
    // Requeue: expired-lease running jobs under the cap → back to 'queued', lease cleared (non-terminal).
    await this.pool.query(
      `UPDATE backtest_job SET
         status = 'queued', queued_at_ms = $1::bigint, leased_by = NULL, lease_expires_at = NULL,
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND lease_expires_at IS NOT NULL
         AND $1::bigint > lease_expires_at AND attempts < $3`,
      [nowMs, JSON.stringify([{ status: 'queued', atMs: nowMs }]), maxAttempts],
    );
    const timedOut = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'timed_out', terminal_at_ms = $1::bigint, terminal_code = 'run_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND run_deadline_ms IS NOT NULL AND $1::bigint > run_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'timed_out', atMs: nowMs }])],
    );
    return [...expired.rows, ...poisoned.rows, ...timedOut.rows].map(rowToJob);
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease.test.ts && pnpm typecheck`
Expected: all worker-lease cases PASS (6 total); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/worker-lease.test.ts
git commit -m "feat(jobs): reapDeadlines requeues expired-lease runs (poison at attempts cap)"
```

---

## Task 4: Config knobs + thread lease through the worker path

Add `WORKER_*` config and make `processNextQueued` claim with a lease and complete with the owner guard.

**Files:**
- Modify: `apps/backtester/src/config.ts`
- Modify: `apps/backtester/src/jobs/worker.ts`
- Modify: `apps/backtester/test/helpers.ts` (add the new config fields to `testConfig`)
- Test: `apps/backtester/test/worker-concurrency.test.ts` (extend) or a new `apps/backtester/test/worker-lease-config.test.ts`

**Interfaces:**
- Consumes: lease store ops (Task 2/3).
- Produces:
  - `AppConfig` fields: `workerId: string`, `workerLeaseTtlMs: number`, `workerHeartbeatMs: number`, `workerMaxAttempts: number`, `workerPollMs: number`.
  - `WorkerDeps.lease?: { workerId: string; ttlMs: number; maxAttempts: number }`.
  - `processNextQueued` claims with `deps.lease` and passes `deps.lease?.workerId` as the `expectLeasedBy` guard on its terminal transitions.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/worker-lease-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('worker lease config', () => {
  it('defaults', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workerLeaseTtlMs).toBe(30_000);
    expect(c.workerHeartbeatMs).toBe(10_000);
    expect(c.workerMaxAttempts).toBe(3);
    expect(c.workerPollMs).toBe(500);
    expect(c.workerId).toMatch(/.+:\d+$/); // hostname:pid
  });
  it('clamps lease TTL to >= 3x heartbeat', () => {
    const c = loadConfig({ WORKER_LEASE_TTL_MS: '5000', WORKER_HEARTBEAT_MS: '4000' } as NodeJS.ProcessEnv);
    expect(c.workerLeaseTtlMs).toBeGreaterThanOrEqual(3 * c.workerHeartbeatMs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease-config.test.ts`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Add config fields**

In `apps/backtester/src/config.ts`, add to the `AppConfig` interface (after `workerConcurrency`):

```ts
  /** Stable id of this worker process (lease owner); default `${hostname}:${pid}`. */
  readonly workerId: string;
  /** Lease TTL (ms) set on claim; clamped to >= 3 * workerHeartbeatMs. */
  readonly workerLeaseTtlMs: number;
  /** Heartbeat interval (ms): workers renew their in-flight leases this often. */
  readonly workerHeartbeatMs: number;
  /** Max claim attempts before a repeatedly-orphaned job is failed (poison). */
  readonly workerMaxAttempts: number;
  /** Idle poll interval (ms) when the queue is empty. */
  readonly workerPollMs: number;
```

In `loadConfig`, add (after the `workerConcurrency` block) — and add `import { hostname } from 'node:os';` at the top:

```ts
  const heartbeat = Math.max(1000, Math.floor(Number(env.WORKER_HEARTBEAT_MS ?? 10_000)) || 10_000);
  const leaseTtl = Math.max(
    3 * heartbeat,
    Math.floor(Number(env.WORKER_LEASE_TTL_MS ?? 30_000)) || 30_000,
  );
  const maxAttempts = Math.max(1, Math.floor(Number(env.WORKER_MAX_ATTEMPTS ?? 3)) || 3);
  const pollMs = Math.max(50, Math.floor(Number(env.WORKER_POLL_MS ?? 500)) || 500);
  const workerId = env.WORKER_ID ?? `${hostname()}:${process.pid}`;
```

And add to the returned config object:

```ts
    workerId,
    workerLeaseTtlMs: leaseTtl,
    workerHeartbeatMs: heartbeat,
    workerMaxAttempts: maxAttempts,
    workerPollMs: pollMs,
```

- [ ] **Step 4: Add the fields to the test config helper**

In `apps/backtester/test/helpers.ts`, add to the object returned by `testConfig` (after `workerConcurrency: 1,`):

```ts
    workerId: 'test-worker',
    workerLeaseTtlMs: 30_000,
    workerHeartbeatMs: 10_000,
    workerMaxAttempts: 3,
    workerPollMs: 500,
```

- [ ] **Step 5: Thread the lease through `processNextQueued`**

In `apps/backtester/src/jobs/worker.ts`, add to the `WorkerDeps` interface:

```ts
  /** When set, the worker claims with a lease and owner-guards its terminal transitions. */
  lease?: { workerId: string; ttlMs: number; maxAttempts: number };
```

In `processNextQueued`, pass the lease on claim:

```ts
  const claimed = await deps.store.claimNextQueued(
    deps.clock(),
    deps.lease ? { workerId: deps.lease.workerId, ttlMs: deps.lease.ttlMs } : undefined,
  );
```

And pass the owner guard on BOTH terminal transitions near the end of `processNextQueued` (the `running→completed` and `running→<terminalStatus>` calls — add the 5th arg `deps.lease?.workerId`):

```ts
    await deps.store.transition(runId, 'running', 'completed', { /* existing patch */ }, deps.lease?.workerId);
```
```ts
    await deps.store.transition(runId, 'running', terminalStatus, { /* existing patch */ }, deps.lease?.workerId);
```

(Leave the existing patch objects exactly as they are; only append the `deps.lease?.workerId` argument.)

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm exec vitest run apps/backtester/test/worker-lease-config.test.ts && pnpm typecheck`
Expected: config test 2/2 PASS; typecheck clean (helpers.ts now satisfies `AppConfig`).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/src/jobs/worker.ts apps/backtester/test/helpers.ts apps/backtester/test/worker-lease-config.test.ts
git commit -m "feat(worker): WORKER_* lease config + thread lease through processNextQueued"
```

---

## Task 5: Worker loop with heartbeat + crash-recovery & determinism tests

An extractable `runWorkerLoop` that drains via the pool, heartbeats leases of in-flight jobs, and stops on an abort signal. Tested with `InMemoryJobStore` (loop + heartbeat) and a multi-worker determinism/crash test.

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (add `runWorkerLoop`)
- Test: `apps/backtester/test/worker-loop.test.ts`

**Interfaces:**
- Consumes: `drainQueue`, `processNextQueued`, `WorkerDeps.lease`, `store.renewLease`, `reapAndPublish`.
- Produces: `runWorkerLoop(deps: WorkerDeps, opts: { concurrency: number; heartbeatMs: number; pollMs: number; signal: AbortSignal }): Promise<void>` — loops `drainQueue(deps, concurrency)`; while running, a heartbeat timer calls `deps.store.renewLease(deps.lease.workerId, deps.clock() + deps.lease.ttlMs)` every `heartbeatMs`; when the queue drains empty, waits `pollMs` then retries; resolves when `signal` is aborted (after the in-flight `drainQueue` settles). Periodically calls `reapAndPublish(deps)` so a single worker also recovers orphans.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/worker-loop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { runWorkerLoop, type WorkerDeps } from '../src/jobs/worker.js';

// Minimal deps with a fake executor path: we use a store preloaded with jobs whose run is a no-op
// by pointing processNextQueued at a stub. For this unit we exercise loop+heartbeat+abort with a
// store that has queued jobs and a fake run via a deps.runOne override is NOT available, so we test
// the loop's lease heartbeat + drain-to-empty + abort using a store spy.

function newJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds',
    runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
  };
}

it('heartbeat renews the in-flight lease; abort stops the loop', async () => {
  const store = new InMemoryJobStore();
  let renews = 0;
  const origRenew = store.renewLease.bind(store);
  store.renewLease = async (w, until) => { renews += 1; return origRenew(w, until); };

  // one long "running" job already claimed by this worker so the heartbeat has something to renew
  await store.insertOrGet(newJob('r1'));
  await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
  await store.claimNextQueued(1000, { workerId: 'w1', ttlMs: 30_000 });

  const ac = new AbortController();
  const deps = {
    store, clock: () => Date.now(), uid: () => 'u', postWebhook: async () => {},
    dataPort: {} as never, artifactStore: {} as never, overlaySandbox: {} as never,
    lease: { workerId: 'w1', ttlMs: 30_000, maxAttempts: 3 },
  } as unknown as WorkerDeps;

  const before = (await store.get('r1'))!.leaseExpiresAt!;
  const loop = runWorkerLoop(deps, { concurrency: 1, heartbeatMs: 20, pollMs: 10, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 70));
  ac.abort();
  await loop;

  expect(renews).toBeGreaterThanOrEqual(1);
  expect((await store.get('r1'))!.leaseExpiresAt!).toBeGreaterThan(before);
}, 5_000);
```

(Note: this unit drives the loop with no claimable queued jobs after the one pre-claimed run, so `drainQueue` returns 0 quickly and the loop idles on `pollMs` while the heartbeat fires — exactly what we assert. The full run-execution path is covered by the Docker-gated determinism test below.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/worker-loop.test.ts`
Expected: FAIL — `runWorkerLoop` not exported.

- [ ] **Step 3: Implement `runWorkerLoop`**

In `apps/backtester/src/jobs/worker.ts`, add (it already imports `reapAndPublish`? if not, add `import { reapAndPublish } from './completion';` — check existing imports and reuse):

```ts
/**
 * Long-lived worker drain loop. Drains via the bounded pool, heartbeats its leases on in-flight jobs,
 * recovers orphans via reapAndPublish, idles on pollMs when empty, and resolves when `signal` aborts.
 */
export async function runWorkerLoop(
  deps: WorkerDeps,
  opts: { concurrency: number; heartbeatMs: number; pollMs: number; signal: AbortSignal },
): Promise<void> {
  const beat = setInterval(() => {
    if (deps.lease) void deps.store.renewLease(deps.lease.workerId, deps.clock() + deps.lease.ttlMs);
  }, opts.heartbeatMs);
  try {
    while (!opts.signal.aborted) {
      const processed = await drainQueue(deps, opts.concurrency);
      await reapAndPublish(deps);
      if (opts.signal.aborted) break;
      if (processed === 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.pollMs);
          opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    }
  } finally {
    clearInterval(beat);
  }
}
```

- [ ] **Step 4: Run unit test**

Run: `pnpm exec vitest run apps/backtester/test/worker-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the Docker/PG-gated determinism + crash-recovery test**

Append to `apps/backtester/test/worker-loop.test.ts` a `describe.skipIf(!DOCKER_AVAILABLE)` block (import `DOCKER_AVAILABLE` from `./store-factories.js`, and the PG store factory the repo uses there). Using a real `PgJobStore` (the factory) and the real overlay sandbox deps (mirror `overlay-sandbox-session.test.ts` / `helpers-overlay-sandbox.ts` for building `WorkerDeps` with a real dataPort/artifactStore/bundleStore), it must:

1. **Determinism across workers:** submit N=4 identical momentum runs (no bundle) via `store.insertOrGet` + queue; run TWO `runWorkerLoop` instances concurrently (workerIds `w1`/`w2`, each `concurrency: 2`) until all 4 are terminal; assert every job `completed` and the multiset of `resultHash` equals a single-worker drain of the same 4 (build the reference by draining 4 more identical jobs with one loop). Goldens must not move.
2. **Crash recovery:** queue 1 job; start worker `wA` that claims it (lease ttl small, e.g. 800 ms) but is then aborted WITHOUT completing (simulate crash: abort immediately after claim, before completion — drive by using a deps whose run is the real path but abort the loop right after the first claim, OR pre-claim with `wA` and never heartbeat); advance time past the lease; run `reapAndPublish` (via a second loop `wB`); assert the job is requeued and then `completed` by `wB`, with the correct `resultHash`.

Keep these as real-store integration assertions (no wall-clock timing assertions beyond generous test timeouts). If precisely simulating a mid-run crash through the full executor is impractical, simulate it at the store level: `wA` claims (lease 800ms), never heartbeats/completes; after >800ms a `wB` loop drains — the reaper requeues `wA`'s orphan and `wB` completes it. Document in the test comment which simulation is used.

- [ ] **Step 6: Run the gated test (skips without Docker)**

Run: `pnpm exec vitest run apps/backtester/test/worker-loop.test.ts`
Expected: unit PASS; the gated block PASSES with Docker (determinism multiset equal; crash job requeued+completed) or SKIPS without.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/worker-loop.test.ts
git commit -m "feat(worker): runWorkerLoop with lease heartbeat + crash-recovery/determinism tests"
```

---

## Task 6: Worker entrypoint + API-node autoWorker gate

The thin `worker-main.ts` process and the API-node split.

**Files:**
- Create: `apps/backtester/src/worker-main.ts`
- Modify: `apps/backtester/src/index.ts`
- Modify: `apps/backtester/package.json`
- Test: `apps/backtester/test/worker-main.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `buildApp` (for shared wiring), `runWorkerLoop`, `WorkerDeps`.
- Produces: a `worker` npm script; an exported `assertWorkerConfig(config)` that throws without `DATABASE_URL` (so it is unit-testable without spawning a process).

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/worker-main.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertWorkerConfig } from '../src/worker-main.js';
import { loadConfig } from '../src/config.js';

describe('worker-main', () => {
  it('fails fast without DATABASE_URL', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv); // no DATABASE_URL
    expect(() => assertWorkerConfig(c)).toThrow(/DATABASE_URL/);
  });
  it('accepts a config with databaseUrl', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv);
    expect(() => assertWorkerConfig(c)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/worker-main.test.ts`
Expected: FAIL — module/`assertWorkerConfig` missing.

- [ ] **Step 3: Write `worker-main.ts`**

Create `apps/backtester/src/worker-main.ts`:

```ts
// Worker-node entrypoint: drain the shared Postgres queue (no HTTP). Run M of these against one
// DATABASE_URL alongside one API node (BACKTESTER_AUTO_WORKER=false). Multi-process REQUIRES Postgres.

import { buildApp, type AppHandles } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { runWorkerLoop } from './jobs/worker.js';

export function assertWorkerConfig(config: AppConfig): void {
  if (!config.databaseUrl) {
    throw new Error(
      'worker-main requires DATABASE_URL (multi-process drains the shared Postgres queue; ' +
        'the in-memory store is per-process and cannot be shared).',
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertWorkerConfig(config);
  const app: AppHandles = await buildApp(config);
  const ac = new AbortController();
  const deps = app.workerDeps; // exposed by buildApp (Step 4)
  const lease = { workerId: config.workerId, ttlMs: config.workerLeaseTtlMs, maxAttempts: config.workerMaxAttempts };

  // eslint-disable-next-line no-console
  console.log(`trading-backtester worker ${config.workerId} draining (concurrency=${config.workerConcurrency})`);
  const loop = runWorkerLoop(
    { ...deps, lease },
    {
      concurrency: config.workerConcurrency,
      heartbeatMs: config.workerHeartbeatMs,
      pollMs: config.workerPollMs,
      signal: ac.signal,
    },
  );

  const shutdown = async (): Promise<void> => {
    ac.abort();
    await loop;
    await app.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await loop;
}

// Only run when executed directly (not when imported by the unit test).
if (process.argv[1] && process.argv[1].endsWith('worker-main.js')) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Expose `workerDeps` from `buildApp`**

In `apps/backtester/src/app.ts`, add `workerDeps` to the returned `AppHandles` object (it is already built as the local `workerDeps`). Add `workerDeps: WorkerDeps;` to the `AppHandles` interface (import `WorkerDeps` type) and include `workerDeps` in the returned object literal next to `drain`/`reap`/`dispose`.

- [ ] **Step 5: Gate the API node's drain on `autoWorker`**

In `apps/backtester/src/index.ts`, change the unconditional `app.startWorker();` to:

```ts
  if (config.autoWorker) app.startWorker();
```

(Single-process default `autoWorker=true` is unchanged; an API node in multi-process runs with `BACKTESTER_AUTO_WORKER=false` and serves HTTP only.)

- [ ] **Step 6: Add the worker start script**

In `apps/backtester/package.json` `scripts`, add (mirror the existing service start script's runtime; if the service uses `tsx`/`node dist/index.js`, match it):

```json
    "worker": "node dist/worker-main.js"
```

(If the repo runs TS directly in dev, also add `"worker:dev": "tsx src/worker-main.ts"` matching the existing dev script style.)

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm exec vitest run apps/backtester/test/worker-main.test.ts && pnpm typecheck`
Expected: worker-main 2/2 PASS; typecheck clean.

- [ ] **Step 8: Full suite + commit**

Run: `pnpm test`
Expected: full suite green (Docker-gated worker-loop block runs if Docker present); goldens unchanged.

```bash
git add apps/backtester/src/worker-main.ts apps/backtester/src/index.ts apps/backtester/src/app.ts apps/backtester/package.json apps/backtester/test/worker-main.test.ts
git commit -m "feat(worker): worker-main entrypoint + API-node autoWorker gate"
```

---

## Self-Review

**Spec coverage:**
- Two roles, one codebase / API node autoWorker off / worker-node entrypoint → Task 6. ✅
- Worker loop + poll + graceful shutdown → Task 5 (`runWorkerLoop` + abort) + Task 6 (signals). ✅
- Lease columns + migration → Task 1. ✅
- Claim sets lease + attempts; heartbeat `renewLease`; reaper requeues/poisons; owner-guard → Tasks 2, 3, 5. ✅
- `running→queued` lifecycle → Task 1. ✅
- Config knobs (WORKER_*) + clamps → Task 4. ✅
- PgJobStore SQL + migration; InMemory parity → Tasks 1–3. ✅
- Fail-fast without DATABASE_URL → Task 6. ✅
- Tests: lease unit, concurrent-claim lease, crash recovery, at-least-once owner-guard, determinism across workers, graceful shutdown, fail-fast → Tasks 2, 3, 5, 6. ✅
- Determinism / goldens unchanged → Task 5 (determinism-across-workers) + Task 6 (full suite). ✅
- Deviation from spec (improvement): `renewLease(workerId, untilMs)` is worker-scoped (one UPDATE over all this worker's running jobs) instead of `renewLease(runIds, workerId, until)` — the worker need not track runIds. Recorded here.

**Placeholder scan:** No TBD/TODO; every code step shows code; "UNCHANGED" markers point at verbatim-preserved existing blocks. Task 5 Step 5 and Task 6 Step 6 give explicit construction guidance referencing concrete existing files to mirror (`helpers-overlay-sandbox.ts`, the service start script) rather than inventing unknowns — the implementer must read those, named explicitly.

**Type consistency:** `claimNextQueued(nowMs, lease?)`, `renewLease(workerId, untilMs)`, `transition(..., expectLeasedBy?)`, `reapDeadlines(nowMs, opts?)`, `WorkerDeps.lease`, `runWorkerLoop(deps, {concurrency,heartbeatMs,pollMs,signal})`, and the `AppConfig.worker*` fields are used identically across tasks and match the InMemory + Pg implementations. `attempts` is incremented on claim and checked (`>=`/`<`) in the reaper consistently.
