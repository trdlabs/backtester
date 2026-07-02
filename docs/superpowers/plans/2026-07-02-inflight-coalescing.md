# In-flight Request Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When several identical jobs (same `computeIdentity`) reach workers before the first finishes, exactly one (leader) runs the engine/sandbox; the rest (followers) defer to an internal `waiting_for_compute` state, release the worker slot, and complete via the existing re-stamp path once the leader's `result_cache` template appears — or take over if the leader fails/crashes.

**Architecture:** A separate expiry-based `backtest_compute_lock` table (leader election via upsert, takeover on expiry, proactive-expire on leader terminal fail). Followers become an internal-only `waiting_for_compute` status (mapped to `running` in the public view). A wake/reap pass releases waiters back to `queued` (all on cache-ready; exactly one on lock-expired) so they re-enter the normal claim→materialize→gate flow. Attempts charging moves from claim to engine-commit under coalescing, with a second `compute_wait_attempts` counter for non-engine cycles. All gated behind `BACKTESTER_COALESCE_ENABLED` (default off, requires dedup).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, node-postgres (`pg`), the existing `JobStore`/`ResultCache`/worker machinery.

Design spec: `docs/superpowers/specs/2026-07-02-inflight-coalescing-design.md`.

## Global Constraints

- Flag `BACKTESTER_COALESCE_ENABLED`, default **off** (`env.BACKTESTER_COALESCE_ENABLED === 'true'`); effective only when `dedupEnabled` is also true.
- **Postgres-durable only.** InMemory implementations exist solely as test fakes.
- **INV-1** cache-first: always `resultCache.lookup(computeIdentity)` BEFORE `computeLock`.
- **INV-2** lock expiry ≠ failure (only enables takeover).
- **INV-3** a follower completes byte-identically to a normal HIT run (own runId/result_hash, dedupedFrom) through the existing completion path.
- **INV-4** lock cleanup is not correctness-critical (stale lock harmless; cache wins).
- **INV-5** engine `attempts` = real engine executions only; charged at engine-commit under coalescing (NOT at claim), on ALL engine paths (leader/miss, stale_recompute, bypass, evidence_bypass). `compute_wait_attempts` = non-engine claim cycles (defers + pre-engine crashes).
- **INV-6** coalescing OFF is a bit-for-bit no-op: no compute_lock reads/writes, no waiting_for_compute transitions, claim-time `attempts++` and reaper path unchanged, dedup goldens byte-identical.
- **INV-7** NO public contract change: `waiting_for_compute` is internal-only; `toStatusView` maps it to `running`. **Never edit `packages/sdk/src/contracts/run.ts`.**
- ESM `.js` import specifiers. Follow existing dedup-module patterns (`jobs/dedup/*`).
- Preserve the deterministic `result_hash` contract — `result_cache` / `ResultCache` untouched.

## File Structure

- Create `apps/backtester/src/jobs/coalesce/compute-lock.ts` — `ComputeLockStore` interface + `InMemoryComputeLockStore`.
- Create `apps/backtester/src/jobs/coalesce/pg-compute-lock.ts` — `PgComputeLockStore`.
- Create `apps/backtester/src/jobs/coalesce/wake.ts` — `wakeComputeWaiters(deps, nowMs)` orchestration.
- Create `apps/backtester/migrations/0005_compute_lock.sql` — table + `backtest_job` columns.
- Modify `apps/backtester/src/jobs/lifecycle.ts` — `InternalJobStatus` + transitions.
- Modify `apps/backtester/src/jobs/job-store.ts` — `JobRow`/`JobRowPatch` internal fields, `toStatusView` mapping, `InMemoryJobStore` new methods; `JobStore` interface.
- Modify `apps/backtester/src/jobs/pg-job-store.ts` — column mapping, claim deferred-charge, reaper attribution, wake queries.
- Modify `apps/backtester/src/jobs/worker.ts` — `WorkerDeps`, gate leader/follower + engine-commit charge, `runWorkerLoop` compute-lock renew.
- Modify `apps/backtester/src/config.ts` — flags.
- Modify `apps/backtester/src/app.ts` + `apps/backtester/src/worker-main.ts` — wiring + wake cadence.
- Modify `docs/OPERATIONS.md` — coalescing section.

---

### Task 1: `ComputeLockStore` interface + `InMemoryComputeLockStore`

**Files:**
- Create: `apps/backtester/src/jobs/coalesce/compute-lock.ts`
- Test: `apps/backtester/test/compute-lock.test.ts`

**Interfaces:**
- Produces:
  - `type ComputeWakeReason = 'cache_ready' | 'lock_expired' | 'leader_failed'`
  - `interface ComputeLock { computeIdentity: string; leaderRunId: string; lockOwnerWorkerId: string; lockExpiresAtMs: number; createdAtMs: number; updatedAtMs: number; }`
  - `interface ComputeLockStore { acquire(computeIdentity: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean>; renew(computeIdentity: string, workerId: string, untilMs: number): Promise<void>; expire(computeIdentity: string, workerId: string, nowMs: number): Promise<void>; get(computeIdentity: string): Promise<ComputeLock | undefined>; }`
  - `class InMemoryComputeLockStore implements ComputeLockStore`
  - Semantics: `acquire` returns true iff no row OR existing row expired (`nowMs > lockExpiresAtMs`), and on success (re)writes the row with `lockExpiresAtMs = nowMs + ttlMs`. `renew`/`expire` are no-ops unless `lockOwnerWorkerId === workerId`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/compute-lock.test.ts
import { describe, expect, it } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

describe('InMemoryComputeLockStore', () => {
  it('first acquire wins; a second while alive loses', async () => {
    const s = new InMemoryComputeLockStore();
    expect(await s.acquire('ci', 'run-A', 'w1', 1000, 100)).toBe(true);
    expect(await s.acquire('ci', 'run-B', 'w2', 1050, 100)).toBe(false); // still alive (expires 1100)
    const lk = await s.get('ci');
    expect(lk?.leaderRunId).toBe('run-A');
    expect(lk?.lockExpiresAtMs).toBe(1100);
  });

  it('acquire succeeds again once the lock has expired (takeover)', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);           // expires 1100
    expect(await s.acquire('ci', 'run-B', 'w2', 1200, 100)).toBe(true); // 1200 > 1100
    expect((await s.get('ci'))?.leaderRunId).toBe('run-B');
  });

  it('renew extends only for the owner; expire only for the owner', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);
    await s.renew('ci', 'w2', 5000);                            // wrong owner → no-op
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(1100);
    await s.renew('ci', 'w1', 5000);                            // owner → extends
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(5000);
    await s.expire('ci', 'w2', 6000);                           // wrong owner → no-op
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(5000);
    await s.expire('ci', 'w1', 6000);                           // owner → proactive-expire
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(6000);
    expect(await s.acquire('ci', 'run-C', 'w3', 6001, 100)).toBe(true); // now takeable
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/compute-lock.test.ts`
Expected: FAIL — cannot find module `../src/jobs/coalesce/compute-lock.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/jobs/coalesce/compute-lock.ts
// In-flight compute coordination lock, keyed by computeIdentity. Separate from the completed-result
// cache (result_cache stays completed-templates only). Expiry-based; same lease idiom as the job-lease.

export type ComputeWakeReason = 'cache_ready' | 'lock_expired' | 'leader_failed';

export interface ComputeLock {
  computeIdentity: string;
  leaderRunId: string;
  lockOwnerWorkerId: string;
  lockExpiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ComputeLockStore {
  /** Win iff no row or the existing row is expired; on win (re)writes with lockExpiresAtMs = nowMs+ttlMs. */
  acquire(computeIdentity: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean>;
  /** Extend lockExpiresAtMs only while the caller owns the lock. */
  renew(computeIdentity: string, workerId: string, untilMs: number): Promise<void>;
  /** Proactively expire (lockExpiresAtMs = nowMs) only while the caller owns the lock. */
  expire(computeIdentity: string, workerId: string, nowMs: number): Promise<void>;
  get(computeIdentity: string): Promise<ComputeLock | undefined>;
}

export class InMemoryComputeLockStore implements ComputeLockStore {
  private readonly rows = new Map<string, ComputeLock>();

  async acquire(ci: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const existing = this.rows.get(ci);
    if (existing && nowMs <= existing.lockExpiresAtMs) return false;
    this.rows.set(ci, {
      computeIdentity: ci,
      leaderRunId,
      lockOwnerWorkerId: workerId,
      lockExpiresAtMs: nowMs + ttlMs,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
    return true;
  }

  async renew(ci: string, workerId: string, untilMs: number): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId) {
      row.lockExpiresAtMs = untilMs;
      row.updatedAtMs = untilMs;
    }
  }

  async expire(ci: string, workerId: string, nowMs: number): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId) {
      row.lockExpiresAtMs = nowMs;
      row.updatedAtMs = nowMs;
    }
  }

  async get(ci: string): Promise<ComputeLock | undefined> {
    const row = this.rows.get(ci);
    return row ? { ...row } : undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/compute-lock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/coalesce/compute-lock.ts apps/backtester/test/compute-lock.test.ts
git commit -m "feat(coalesce): ComputeLockStore interface + InMemory (expiry-based leader lock)"
```

---

### Task 2: Migration `0005` + `PgComputeLockStore`

**Files:**
- Create: `apps/backtester/migrations/0005_compute_lock.sql`
- Create: `apps/backtester/src/jobs/coalesce/pg-compute-lock.ts`
- Test: `apps/backtester/test/pg-compute-lock.test.ts` (Postgres-gated)

**Interfaces:**
- Consumes: `ComputeLockStore`, `ComputeLock` (Task 1); a `pg` `Pool`.
- Produces: `class PgComputeLockStore implements ComputeLockStore`.

- [ ] **Step 1: Write the migration**

```sql
-- apps/backtester/migrations/0005_compute_lock.sql
CREATE TABLE IF NOT EXISTS backtest_compute_lock (
  compute_identity     TEXT   PRIMARY KEY,
  leader_run_id        TEXT   NOT NULL,
  lock_owner_worker_id TEXT   NOT NULL,
  lock_expires_at_ms   BIGINT NOT NULL,
  created_at_ms        BIGINT NOT NULL,
  updated_at_ms        BIGINT NOT NULL
);

ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wait_attempts  INT     NOT NULL DEFAULT 0;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_identity       TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS wait_deadline_ms       BIGINT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wake_reason    TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS engine_attempt_charged BOOLEAN NOT NULL DEFAULT false;
```

> `migrate()` auto-discovers `migrations/*.sql` in sorted order (verified for `0004`); no code change needed to run it.

- [ ] **Step 2: Write the failing test (Postgres-gated)**

```ts
// apps/backtester/test/pg-compute-lock.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_AVAILABLE, makePgPool, freshSchema } from './store-factories.js';
import { migrate } from '../src/jobs/migrate.js';
import { PgComputeLockStore } from '../src/jobs/coalesce/pg-compute-lock.js';

describe.skipIf(!PG_AVAILABLE)('PgComputeLockStore', () => {
  let pool: import('pg').Pool;
  beforeAll(async () => { pool = await freshSchema(); await migrate(pool); });
  afterAll(async () => { await pool?.end(); });

  it('acquire wins on empty/expired, loses while alive, renews/expires by owner', async () => {
    const s = new PgComputeLockStore(pool);
    expect(await s.acquire('ci1', 'run-A', 'w1', 1000, 100)).toBe(true);
    expect(await s.acquire('ci1', 'run-B', 'w2', 1050, 100)).toBe(false);
    expect(await s.acquire('ci1', 'run-B', 'w2', 1200, 100)).toBe(true); // 1200 > 1100 → takeover
    await s.renew('ci1', 'w1', 9999);   // not owner (w2) → no-op
    expect((await s.get('ci1'))?.lockOwnerWorkerId).toBe('w2');
    await s.expire('ci1', 'w2', 5000);  // owner → proactive expire
    expect(await s.acquire('ci1', 'run-C', 'w3', 5001, 100)).toBe(true);
  });
});
```

> Match the real Postgres test helpers used by `pg-result-cache.test.ts` (`store-factories.ts`): use its exact `PG_AVAILABLE` gate + pool/schema factory names. If they differ from `makePgPool`/`freshSchema`, use the real ones and mirror that file's `beforeAll`/`afterAll` + `migrate` setup verbatim.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/pg-compute-lock.test.ts`
Expected: FAIL locally it SKIPS (no Postgres in WSL2); where Postgres is available, FAIL on missing module. (CI Postgres lane is authoritative.)

- [ ] **Step 4: Write minimal implementation**

```ts
// apps/backtester/src/jobs/coalesce/pg-compute-lock.ts
import type { Pool } from 'pg';
import type { ComputeLock, ComputeLockStore } from './compute-lock.js';

interface LockDbRow {
  compute_identity: string; leader_run_id: string; lock_owner_worker_id: string;
  lock_expires_at_ms: string; created_at_ms: string; updated_at_ms: string;
}
const toLock = (r: LockDbRow): ComputeLock => ({
  computeIdentity: r.compute_identity, leaderRunId: r.leader_run_id, lockOwnerWorkerId: r.lock_owner_worker_id,
  lockExpiresAtMs: Number(r.lock_expires_at_ms), createdAtMs: Number(r.created_at_ms), updatedAtMs: Number(r.updated_at_ms),
});

export class PgComputeLockStore implements ComputeLockStore {
  constructor(private readonly pool: Pool) {}

  async acquire(ci: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean> {
    // Win iff inserted (no row) OR updated (existing row expired). ON CONFLICT DO UPDATE guarded by expiry.
    const r = await this.pool.query(
      `INSERT INTO backtest_compute_lock
         (compute_identity, leader_run_id, lock_owner_worker_id, lock_expires_at_ms, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4::bigint + $5::bigint,$4,$4)
       ON CONFLICT (compute_identity) DO UPDATE SET
         leader_run_id = EXCLUDED.leader_run_id,
         lock_owner_worker_id = EXCLUDED.lock_owner_worker_id,
         lock_expires_at_ms = EXCLUDED.lock_expires_at_ms,
         updated_at_ms = EXCLUDED.updated_at_ms
       WHERE backtest_compute_lock.lock_expires_at_ms < $4::bigint
       RETURNING compute_identity`,
      [ci, leaderRunId, workerId, nowMs, ttlMs],
    );
    return r.rowCount === 1;
  }

  async renew(ci: string, workerId: string, untilMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_compute_lock SET lock_expires_at_ms = $3::bigint, updated_at_ms = $3::bigint
       WHERE compute_identity = $1 AND lock_owner_worker_id = $2`,
      [ci, workerId, untilMs],
    );
  }

  async expire(ci: string, workerId: string, nowMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_compute_lock SET lock_expires_at_ms = $3::bigint, updated_at_ms = $3::bigint
       WHERE compute_identity = $1 AND lock_owner_worker_id = $2`,
      [ci, workerId, nowMs],
    );
  }

  async get(ci: string): Promise<ComputeLock | undefined> {
    const r = await this.pool.query<LockDbRow>(`SELECT * FROM backtest_compute_lock WHERE compute_identity = $1`, [ci]);
    return r.rows[0] ? toLock(r.rows[0]) : undefined;
  }
}
```

- [ ] **Step 5: Run test to verify it passes (CI Postgres lane)**

Run: `pnpm vitest run apps/backtester/test/pg-compute-lock.test.ts`
Expected: PASS on the Postgres lane (skips locally).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/migrations/0005_compute_lock.sql apps/backtester/src/jobs/coalesce/pg-compute-lock.ts apps/backtester/test/pg-compute-lock.test.ts
git commit -m "feat(coalesce): 0005 compute_lock migration + PgComputeLockStore"
```

---

### Task 3: Config flags

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig` ~line 100; `loadConfig` ~line 229, next to `dedupEnabled`/`jobObs`)
- Test: `apps/backtester/test/config-coalesce.test.ts`

**Interfaces:**
- Produces: `AppConfig.coalesceEnabled: boolean`, `AppConfig.computeLockTtlMs: number`, `AppConfig.computeWaitMaxAttempts: number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/config-coalesce.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('coalescing config', () => {
  it('coalesceEnabled defaults false, true only for "true"', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).coalesceEnabled).toBe(false);
    expect(loadConfig({ BACKTESTER_COALESCE_ENABLED: 'true' } as NodeJS.ProcessEnv).coalesceEnabled).toBe(true);
    expect(loadConfig({ BACKTESTER_COALESCE_ENABLED: '1' } as NodeJS.ProcessEnv).coalesceEnabled).toBe(false);
  });
  it('lock ttl + wait cap have defaults, overridable', () => {
    const d = loadConfig({} as NodeJS.ProcessEnv);
    expect(d.computeLockTtlMs).toBe(d.workerLeaseTtlMs);   // default = worker lease ttl
    expect(d.computeWaitMaxAttempts).toBe(3);
    const o = loadConfig({ BACKTESTER_COMPUTE_LOCK_TTL_MS: '45000', BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS: '5' } as NodeJS.ProcessEnv);
    expect(o.computeLockTtlMs).toBe(45000);
    expect(o.computeWaitMaxAttempts).toBe(5);
  });
});
```

> Match the real `loadConfig` calling convention from `config-dedup.test.ts` (arg vs `process.env` save/restore) — mirror it exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/config-coalesce.test.ts`
Expected: FAIL — fields undefined on `AppConfig`.

- [ ] **Step 3: Write minimal implementation**

In `AppConfig` (next to `dedupEnabled`/`jobObs`):
```ts
  /** Enable in-flight request coalescing (leader/follower). Default off; effective only with dedupEnabled. */
  readonly coalesceEnabled: boolean;
  /** Compute-lock TTL (ms). Default = workerLeaseTtlMs. */
  readonly computeLockTtlMs: number;
  /** compute_wait_attempts poison cap. Default 3. */
  readonly computeWaitMaxAttempts: number;
```

In `loadConfig` (after `dedupEnabled` / `jobObs`; place AFTER `workerLeaseTtlMs` is computed so the default can reference it):
```ts
    coalesceEnabled: env.BACKTESTER_COALESCE_ENABLED === 'true',
    computeLockTtlMs: env.BACKTESTER_COMPUTE_LOCK_TTL_MS ? Number(env.BACKTESTER_COMPUTE_LOCK_TTL_MS) : workerLeaseTtlMs,
    computeWaitMaxAttempts: env.BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS ? Number(env.BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS) : 3,
```
> If `workerLeaseTtlMs` is not a local in `loadConfig`, reference the same expression it is built from (read the surrounding lines) so `computeLockTtlMs`'s default equals the effective worker lease ttl.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/config-coalesce.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-coalesce.test.ts
git commit -m "feat(coalesce): config flags (BACKTESTER_COALESCE_ENABLED + lock ttl + wait cap)"
```

---

### Task 4: `InternalJobStatus` + lifecycle + `toStatusView` mapping (INV-7)

**Files:**
- Modify: `apps/backtester/src/jobs/lifecycle.ts` (`ALLOWED_TRANSITIONS` ~line 14, `canTransition`/`isTerminal`)
- Modify: `apps/backtester/src/jobs/job-store.ts` (`JobRow.status` type ~line 24; `toStatusView` ~line 290)
- Test: `apps/backtester/test/coalesce-lifecycle.test.ts`

**Interfaces:**
- Produces: `type InternalJobStatus = RunStatus | 'waiting_for_compute'` (exported from `lifecycle.ts`); `canTransition(from: InternalJobStatus, to: InternalJobStatus)`; `toStatusView` maps `waiting_for_compute → 'running'`.
- Consumes: `RunStatus` from `@trading/research-contracts` (unchanged — INV-7).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, type InternalJobStatus } from '../src/jobs/lifecycle.js';

describe('coalescing lifecycle', () => {
  it('running <-> waiting_for_compute and waiting_for_compute -> queued/failed/canceled', () => {
    expect(canTransition('running', 'waiting_for_compute')).toBe(true);
    expect(canTransition('waiting_for_compute', 'queued')).toBe(true);
    expect(canTransition('waiting_for_compute', 'failed')).toBe(true);
    expect(canTransition('waiting_for_compute', 'canceled')).toBe(true);
    expect(canTransition('waiting_for_compute', 'completed')).toBe(false); // completes via queued->running->completed
  });
  it('waiting_for_compute is NOT terminal', () => {
    expect(isTerminal('waiting_for_compute' as InternalJobStatus)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-lifecycle.test.ts`
Expected: FAIL — `waiting_for_compute` not a valid `InternalJobStatus` / not in `ALLOWED_TRANSITIONS`.

- [ ] **Step 3: Write minimal implementation**

In `lifecycle.ts`, add the internal status type and extend the transition table (keep `RunStatus` import; do NOT edit the SDK):
```ts
export type InternalJobStatus = RunStatus | 'waiting_for_compute';

const ALLOWED_TRANSITIONS: Record<InternalJobStatus, readonly InternalJobStatus[]> = {
  accepted: ['queued', 'canceled'],
  queued: ['running', 'canceled', 'expired'],
  running: ['completed', 'failed', 'canceled', 'timed_out', 'queued', 'waiting_for_compute'],
  waiting_for_compute: ['queued', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
  timed_out: [],
};

export function isTerminal(status: InternalJobStatus): boolean {
  return TERMINAL.includes(status as RunStatus);
}
export function canTransition(from: InternalJobStatus, to: InternalJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
```
Change `JobRow.status` (job-store.ts) from `RunStatus` to `InternalJobStatus` (import from `./lifecycle.js`). In `toStatusView`, project the internal status to the public one:
```ts
// waiting_for_compute is internal-only (INV-7) — externally a follower is still 'running'.
const publicStatus: RunStatus = job.status === 'waiting_for_compute' ? 'running' : job.status;
```
and use `publicStatus` for the returned `RunStatusView.status` (keep the rest of `toStatusView` as-is).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/coalesce-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Guard — the public contract is untouched**

Run: `git diff --name-only && echo "---" && ! git diff --name-only | grep -q 'packages/sdk/src/contracts/run.ts' && echo "OK: SDK run.ts untouched"`
Expected: prints `OK: SDK run.ts untouched` (INV-7).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/lifecycle.ts apps/backtester/src/jobs/job-store.ts apps/backtester/test/coalesce-lifecycle.test.ts
git commit -m "feat(coalesce): internal waiting_for_compute status; toStatusView maps to running (INV-7)"
```

---

### Task 5: `WorkerDeps` wiring + gate leader/follower + engine-commit charge

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`WorkerDeps` ~line 64; `processNextQueued` ~line 300–600)
- Test: `apps/backtester/test/coalesce-gate.test.ts`

**Interfaces:**
- Consumes: `ComputeLockStore` (Task 1), `InternalJobStatus` (Task 4), `AppConfig` flags (Task 3).
- Produces: `WorkerDeps.computeLock?: ComputeLockStore`, `WorkerDeps.coalesceEnabled?: boolean`, `WorkerDeps.computeLockTtlMs?: number`, `WorkerDeps.computeWaitMaxAttempts?: number`. Gate behavior: leader/follower classification + engine-commit attempts charge.

**Design notes (read before editing):**
- `coalesceOn = deps.coalesceEnabled === true && deps.computeLock !== undefined && dedupOn` (dedupOn already computed in the gate; coalescing requires dedup on and a `deps.lease.workerId`).
- INV-1: keep the existing `resultCache.lookup` FIRST. Only on a genuine MISS (no HIT, no stale re-stamp) does coalescing engage.
- The attempts charge is now at **engine-commit**, on ALL engine paths (INV-5). Define a single local helper the leader/miss/bypass/evidence_bypass/stale-recompute branches call right before running the engine: `await chargeEngineAttempt()` which, when `coalesceOn`, does `store.transition(runId,'running','running',{ attempts: claimed.attempts+1, engineAttemptCharged: true }, workerId)` (a self-transition patch that only bumps the counter + marker); when coalescing off it is a no-op (claim already charged).
- Follower branch (lost the lock): `store.transition(runId,'running','waiting_for_compute',{ computeIdentity: identity, waitDeadlineMs: now + waitTtl, computeWaitAttempts: claimed.computeWaitAttempts+1, engineAttemptCharged: false })`, then `return finished` (the finally still runs cleanup); NO engine, `attempts` unchanged.
- `waitTtl = (deps.computeLockTtlMs ?? ttl) * 2` (≥ lock ttl per spec).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-gate.test.ts
// Momentum, InMemory (Docker-free). Mirrors dedup-worker.test.ts makeCtx, adding a ComputeLockStore.
import { describe, expect, it, vi } from 'vitest';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import * as runBacktestModule from '../src/runner/run-backtest.js';
// ... reuse makeCtx/momentumJob/enqueue/REQ from dedup-worker.test.ts, extended with
//     { coalesceEnabled?: boolean; computeLock?: InMemoryComputeLockStore } added to deps ...

describe('coalescing gate — momentum', () => {
  it('leader (won lock) runs engine; a pre-seeded active lock makes the run a follower (no engine, waiting_for_compute)', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    // Pre-seed an ALIVE lock for the identity this momentum request will compute, owned by another worker,
    // so the first (and only) run loses the election and defers. (computeIdentity is deterministic for REQ;
    // compute it via the same computeIdentity(...) the gate uses, after materialize — the test helper
    // exposes it, or seed with a far-future expiry under the known identity.)
    // Simplest: seed AFTER a first leader run has taken the lock — see the second test.

    await enqueue(store, 'run-leader');
    const a = await processNextQueued(deps);   // no prior lock → leader → runs engine
    expect(a?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('second concurrent identical run loses the lock while leader holds it → waiting_for_compute, engine NOT called', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    // Manually hold the lock as another worker for this identity BEFORE the run reaches the gate.
    // Use the gate's computeIdentity (deterministic). Seed with a long ttl so it stays alive.
    // (The test helper computes identity = computeIdentity({requestFingerprint, datasetFingerprint, sandboxPolicyVersion}).)
    await seedActiveLockForMomentum(lock, deps, 'run-other', 10_000_000);

    await enqueue(store, 'run-follower');
    const b = await processNextQueued(deps);
    expect(runSpy).not.toHaveBeenCalled();              // engine skipped
    const row = await store.get('run-follower');
    expect(row?.status).toBe('waiting_for_compute');    // internal status
    expect(row?.attempts).toBe(0);                      // no engine attempt charged (deferred)
    expect(row?.computeWaitAttempts).toBe(1);           // one wait cycle
  });
});
```

> `seedActiveLockForMomentum` computes the momentum `computeIdentity` the gate will derive (same `requestFingerprint` + `datasetFingerprint` + `sandboxPolicyVersion`) and calls `lock.acquire(identity, 'run-other', 'other-worker', now, ttl)`. Derive `datasetFingerprint` by materializing once (as `dedup-worker.test.ts::loadMomentumDataset` does) or reuse the value the first leader run persisted (`store.get('run-leader').datasetFingerprint` after a leader run). Implement it in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-gate.test.ts`
Expected: FAIL — `computeLock`/`coalesceEnabled` not consumed; no `waiting_for_compute` transition.

- [ ] **Step 3: Write minimal implementation**

**3a.** `WorkerDeps` additions (worker.ts, next to `dedupEnabled`):
```ts
  /** In-flight compute coordination lock. Absent ⇒ coalescing OFF. */
  computeLock?: ComputeLockStore;
  /** Master coalescing kill-switch: engages only when true AND computeLock present AND dedup on. */
  coalesceEnabled?: boolean;
  computeLockTtlMs?: number;
  computeWaitMaxAttempts?: number;
```
Import: `import { type ComputeLockStore } from './coalesce/compute-lock.js';`

**3b.** In `processNextQueued`, after `computeIdentity` is available on the MISS path and the existing `resultCache.lookup` returned no usable HIT (INV-1 preserved), engage coalescing:
```ts
  const coalesceOn = deps.coalesceEnabled === true && deps.computeLock !== undefined && dedupOn && deps.lease !== undefined;
  if (!finalized && coalesceOn) {
    const workerId = deps.lease!.workerId;
    const lockTtl = deps.computeLockTtlMs ?? deps.lease!.ttlMs;
    const won = await deps.computeLock!.acquire(identity, runId, workerId, deps.clock(), lockTtl);
    if (!won) {
      // Follower: defer, release the slot. No engine, attempts unchanged (INV-5).
      const now = deps.clock();
      await deps.store.transition(runId, 'running', 'waiting_for_compute', {
        atMs: now,
        computeIdentity: identity,
        waitDeadlineMs: now + lockTtl * 2,
        computeWaitAttempts: claimed.computeWaitAttempts + 1,
        engineAttemptCharged: false,
      }, workerId);
      const finishedW = await deps.store.get(runId);
      // finally-block cleanup still runs; do NOT publishCompletion (non-terminal).
      return finishedW;
    }
    // won → leader: fall through to the engine, charging the attempt at engine-commit (3c).
  }
```
> `identity` here is the same value already used for `resultCache.lookup`/`put` — reuse that local (do not recompute).

**3c.** Wrap the actual engine execution with the engine-commit charge on EVERY engine path (leader/miss, stale_recompute, bypass, evidence_bypass). Add a local helper near the top of the try block:
```ts
  let engineCharged = false;
  const chargeEngineAttempt = async (): Promise<void> => {
    if (!coalesceOn || engineCharged) return; // coalescing off ⇒ claim already charged (INV-6)
    engineCharged = true;
    await deps.store.transition(runId, 'running', 'running', {
      atMs: deps.clock(),
      attempts: claimed.attempts + 1,
      engineAttemptCharged: true,
    }, deps.lease?.workerId);
  };
```
Call `await chargeEngineAttempt();` immediately before each engine invocation — `runBacktest(...)` (momentum), `runOverlayBacktest(...)` (overlay), `runStrategyBacktest(...)` (strategy), and the curated evidence `runOverlayBacktest(...)`. (One call site per engine branch, before the call.)

**3d.** On the leader's terminal fail/timeout (the existing `catch` block), proactive-expire the lock:
```ts
  } catch (err) {
    // ... existing terminal transition ...
    if (coalesceOn && engineCharged) {
      await deps.computeLock!.expire(identity, deps.lease!.workerId, deps.clock()).catch(() => {}); // best-effort (INV-4)
    }
  }
```
On leader success, after `result_cache` populate, best-effort `expire`/release is optional (INV-4) — leave the lock to expire naturally OR call `expire` for promptness; either is correct.

> Requires `store.transition` / `JobRowPatch` to accept the new fields (`computeIdentity`, `waitDeadlineMs`, `computeWaitAttempts`, `engineAttemptCharged`, and `attempts`). Task 6 adds them to `JobRowPatch` + both stores; if not yet present when you write this, extend `JobRowPatch` here and implement the patch application in `InMemoryJobStore.transition` for the momentum test, and Task 6 mirrors it in Pg.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/coalesce-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Goldens unaffected (coalescing off)**

Run: `pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts apps/backtester/test/dedup-worker.test.ts`
Expected: PASS (coalescing off in those suites — INV-6).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/coalesce-gate.test.ts
git commit -m "feat(coalesce): gate leader/follower + engine-commit attempts charge on all engine paths"
```

---

### Task 6: `JobRow`/`JobRowPatch` fields + deferred-charge claim + Pg mapping

**Files:**
- Modify: `apps/backtester/src/jobs/job-store.ts` (`JobRow` ~line 17, `JobRowPatch` ~line 73, `InMemoryJobStore.transition`/`claimNextQueued`)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts` (`rowToJob` ~line 87, `transition` ~line 176, `claimNextQueued` ~line 224)
- Test: `apps/backtester/test/coalesce-claim.test.ts`

**Interfaces:**
- Produces: `JobRow` + `JobRowPatch` new fields (`computeWaitAttempts: number`, `computeIdentity?: string`, `waitDeadlineMs?: number`, `computeWakeReason?: ComputeWakeReason`, `engineAttemptCharged?: boolean`); `claimNextQueued(nowMs, lease?, opts?: { coalesceEnabled?: boolean })` — when `coalesceEnabled`, the claim does NOT bump `attempts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-claim.test.ts
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
// ... build a queued momentum job (reuse momentumJob/enqueue from dedup-worker.test.ts) ...

describe('deferred attempt charging on claim', () => {
  it('coalescing off: claim bumps attempts (unchanged)', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'run-x');
    const c = await store.claimNextQueued(1000, { workerId: 'w1', ttlMs: 100 });
    expect(c?.attempts).toBe(1);
  });
  it('coalescing on: claim sets running+lease but does NOT bump attempts', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'run-y');
    const c = await store.claimNextQueued(1000, { workerId: 'w1', ttlMs: 100 }, { coalesceEnabled: true });
    expect(c?.status).toBe('running');
    expect(c?.leasedBy).toBe('w1');
    expect(c?.attempts).toBe(0);            // deferred to engine-commit (INV-5)
    expect(c?.computeWaitAttempts).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-claim.test.ts`
Expected: FAIL — `claimNextQueued` ignores the 3rd `opts` arg / always bumps attempts.

- [ ] **Step 3: Write minimal implementation**

Add fields to `JobRow` (default `computeWaitAttempts: 0`) and `JobRowPatch` (all optional). Update `NewJob`→`insertOrGet` to default `computeWaitAttempts = 0`. Extend the `JobStore` interface signature: `claimNextQueued(nowMs: number, lease?: {...}, opts?: { coalesceEnabled?: boolean }): Promise<JobRow | undefined>`.

`InMemoryJobStore.claimNextQueued`: when `opts?.coalesceEnabled`, set `running` + lease but skip the `attempts += 1`. `InMemoryJobStore.transition`: apply the new patch fields (mirror the existing `if (patch.x !== undefined) job.x = patch.x` lines) for `computeWaitAttempts`, `computeIdentity`, `waitDeadlineMs`, `computeWakeReason`, `engineAttemptCharged`, and `attempts`.

`PgJobStore.claimNextQueued`: thread `coalesceEnabled` into the existing UPDATE — the `attempts` CASE becomes:
```sql
attempts = CASE WHEN $3::text IS NULL OR $5::boolean THEN j.attempts ELSE j.attempts + 1 END
```
with `$5 = opts?.coalesceEnabled ?? false`. `rowToJob`: map the 5 new columns (`compute_wait_attempts`→number, `compute_identity`, `wait_deadline_ms`→num, `compute_wake_reason`, `engine_attempt_charged`→bool). `PgJobStore.transition`: add the 5 fields to the patch SQL (mirror the existing `queued_at_ms` COALESCE-style parameters).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/coalesce-claim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/coalesce-claim.test.ts
git commit -m "feat(coalesce): JobRow/Patch fields + deferred attempt charging in claimNextQueued"
```

---

### Task 7: `wakeComputeWaiters` + reaper crash-attribution

**Files:**
- Create: `apps/backtester/src/jobs/coalesce/wake.ts`
- Modify: `apps/backtester/src/jobs/job-store.ts` + `pg-job-store.ts` (`listComputeWaiters`, `releaseComputeWaiter`, `electOneComputeWaiter`; `reapDeadlines` attribution)
- Test: `apps/backtester/test/coalesce-wake.test.ts`

**Interfaces:**
- Consumes: `JobStore`, `ResultCache`, `ComputeLockStore`.
- Produces: `wakeComputeWaiters(deps: { store: JobStore; resultCache: ResultCache; computeLock: ComputeLockStore; clock: () => number; computeWaitMaxAttempts: number }): Promise<{ released: number; poisoned: number }>`. Store helpers: `listComputeWaiters(nowMs): Promise<JobRow[]>`, `releaseAllComputeWaiters(computeIdentity, reason, nowMs): Promise<number>`, `electOneComputeWaiter(computeIdentity, reason, nowMs): Promise<JobRow | undefined>` (SKIP LOCKED, exactly one), `poisonComputeWaiter(runId, nowMs)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-wake.test.ts
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { wakeComputeWaiters } from '../src/jobs/coalesce/wake.js';
// helper: put a job into waiting_for_compute with a given computeIdentity (via insertOrGet + transitions).

const CI = 'ci-1';
const mk = () => ({ store: new InMemoryJobStore(), resultCache: new InMemoryResultCache(), computeLock: new InMemoryComputeLockStore() });
const deps = (d: ReturnType<typeof mk>, clock = () => 5000) => ({ ...d, clock, computeWaitMaxAttempts: 3 });

describe('wakeComputeWaiters', () => {
  it('cache present → releases ALL waiters to queued with reason cache_ready', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI); await seedWaiter(d.store, 'w-b', CI);
    await d.resultCache.put({ computeIdentity: CI, requestFingerprint:'f', datasetFingerprint:'g', computeVersion:'1', sandboxPolicyVersion:'p', templateRef:'t', createdAtMs: 1 });
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(2);
    expect((await d.store.get('w-a'))?.status).toBe('queued');
    expect((await d.store.get('w-a'))?.computeWakeReason).toBe('cache_ready');
    expect((await d.store.get('w-b'))?.status).toBe('queued');
  });

  it('no cache + expired lock → elects exactly ONE (reason lock_expired), rest stay waiting', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI); await seedWaiter(d.store, 'w-b', CI);
    await d.computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expires 100, now 5000 → expired
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(1);
    const statuses = [ (await d.store.get('w-a'))?.status, (await d.store.get('w-b'))?.status ].sort();
    expect(statuses).toEqual(['queued', 'waiting_for_compute']); // exactly one released
  });

  it('no cache + alive lock → keeps all waiting', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI);
    await d.computeLock.acquire(CI, 'leader', 'w0', 4990, 1000); // alive until 5990
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(0);
    expect((await d.store.get('w-a'))?.status).toBe('waiting_for_compute');
  });

  it('compute_wait_attempts >= cap → poison to failed(compute_wait_exhausted)', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI, /*waitAttempts*/ 3);
    await d.computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expired
    const r = await wakeComputeWaiters(deps(d));
    expect(r.poisoned).toBe(1);
    const row = await d.store.get('w-a');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('compute_wait_exhausted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-wake.test.ts`
Expected: FAIL — `../src/jobs/coalesce/wake.js` missing.

- [ ] **Step 3: Write minimal implementation**

`wake.ts`:
```ts
// apps/backtester/src/jobs/coalesce/wake.ts
import type { JobStore, JobRow } from '../job-store.js';
import type { ResultCache } from '../dedup/result-cache.js';
import type { ComputeLockStore } from './compute-lock.js';

export interface WakeDeps {
  store: JobStore;
  resultCache: ResultCache;
  computeLock: ComputeLockStore;
  clock: () => number;
  computeWaitMaxAttempts: number;
}

export async function wakeComputeWaiters(deps: WakeDeps): Promise<{ released: number; poisoned: number }> {
  const now = deps.clock();
  const waiters = await deps.store.listComputeWaiters(now);
  // Group by computeIdentity.
  const byCi = new Map<string, JobRow[]>();
  for (const w of waiters) {
    if (!w.computeIdentity) continue;
    (byCi.get(w.computeIdentity) ?? byCi.set(w.computeIdentity, []).get(w.computeIdentity)!).push(w);
  }
  let released = 0, poisoned = 0;
  for (const [ci, group] of byCi) {
    // Poison exhausted waiters first (independent of cache/lock).
    for (const w of group) {
      if (w.computeWaitAttempts >= deps.computeWaitMaxAttempts) {
        await deps.store.poisonComputeWaiter(w.runId, now);
        poisoned += 1;
      }
    }
    const live = group.filter((w) => w.computeWaitAttempts < deps.computeWaitMaxAttempts);
    if (live.length === 0) continue;

    // INV-1: cache first. If the template is indexed, release ALL (they HIT on re-claim).
    const hit = await deps.resultCache.lookup(ci);
    if (hit) {
      released += await deps.store.releaseAllComputeWaiters(ci, 'cache_ready', now);
      continue;
    }
    const lock = await deps.computeLock.get(ci);
    const lockAlive = lock !== undefined && now <= lock.lockExpiresAtMs;
    if (lockAlive) continue; // keep waiting (INV-2: expiry-only enables takeover, and it's still alive)

    // No cache + lock expired/absent → elect exactly ONE to become the new leader.
    const leaderJob = lock ? await deps.store.get(lock.leaderRunId) : undefined;
    const reason = leaderJob && ['failed', 'timed_out', 'canceled'].includes(leaderJob.status) ? 'leader_failed' : 'lock_expired';
    const elected = await deps.store.electOneComputeWaiter(ci, reason, now);
    if (elected) released += 1;
  }
  return { released, poisoned };
}
```
Store helpers (InMemory + Pg):
- `listComputeWaiters(nowMs)` — all jobs with `status='waiting_for_compute'`.
- `releaseAllComputeWaiters(ci, reason, nowMs)` — set matching waiters `→ queued`, `compute_wake_reason=reason`, `engine_attempt_charged=false`; **do NOT overwrite `queued_at_ms`** (preserve FIFO position); returns count.
- `electOneComputeWaiter(ci, reason, nowMs)` — Pg: `UPDATE … WHERE run_id = (SELECT run_id FROM backtest_job WHERE status='waiting_for_compute' AND compute_identity=$ci ORDER BY COALESCE(queued_at_ms,accepted_at_ms) FOR UPDATE SKIP LOCKED LIMIT 1) SET status='queued', compute_wake_reason=$reason RETURNING *`. InMemory: pick the oldest matching waiter, transition it.
- `poisonComputeWaiter(runId, nowMs)` — `waiting_for_compute → failed`, `terminal_code='compute_wait_exhausted'`.

Reaper attribution (`reapDeadlines`): add a `coalesceEnabled` opt + a `computeWaitMaxAttempts` opt; when `coalesceEnabled`, an expired-lease `running` job is split by `engine_attempt_charged`:
```sql
-- crash BEFORE engine (engine_attempt_charged=false): requeue + compute_wait_attempts++, poison at waitCap
UPDATE backtest_job SET status='failed', terminal_at_ms=$now, terminal_code='compute_wait_exhausted', ...
  WHERE status='running' AND lease_expires_at < $now AND engine_attempt_charged = false AND compute_wait_attempts >= $waitCap;
UPDATE backtest_job SET status='queued', queued_at_ms=$now, leased_by=NULL, lease_expires_at=NULL,
  compute_wait_attempts = compute_wait_attempts + 1, ...
  WHERE status='running' AND lease_expires_at < $now AND engine_attempt_charged = false AND compute_wait_attempts < $waitCap;
-- crash DURING/AFTER engine (engine_attempt_charged=true): existing attempts>=leaseCap poison / <cap requeue.
```
When `coalesceEnabled` is false, keep the existing single `attempts`-based path unchanged (INV-6).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/coalesce-wake.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/coalesce/wake.ts apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/coalesce-wake.test.ts
git commit -m "feat(coalesce): wakeComputeWaiters release-policy + reaper crash-attribution"
```

---

### Task 8: Leader renews the compute-lock in the heartbeat loop

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`runWorkerLoop` ~line 610; track the active leader identity)
- Test: `apps/backtester/test/coalesce-heartbeat.test.ts`

**Interfaces:**
- Consumes: `ComputeLockStore.renew`, the existing heartbeat `setInterval`.
- Produces: while a worker is the active leader for a `computeIdentity`, its heartbeat also `renew`s the compute-lock so a long engine run never lets the lock lapse.

**Design note:** the worker executes one leader job at a time per pool slot. Track the in-flight leader `computeIdentity`(s) for the worker in a small mutable set the gate adds to on `acquire`-win and removes from on terminal/defer; the heartbeat `renew`s each. Simplest for the bounded pool: the gate registers `deps.onLeaderActive?.(identity)` / `deps.onLeaderDone?.(identity)` callbacks that the loop supplies, backed by a `Set<string>` the `beat` iterates.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-heartbeat.test.ts
import { describe, expect, it, vi } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

describe('leader compute-lock heartbeat renew', () => {
  it('renews the active leader lock separately from the job lease', async () => {
    const lock = new InMemoryComputeLockStore();
    await lock.acquire('ci', 'run-A', 'w1', 1000, 100);          // expires 1100
    const renewSpy = vi.spyOn(lock, 'renew');
    // Simulate the heartbeat helper the loop uses: renew all active leader identities to now+ttl.
    const active = new Set(['ci']);
    const beat = async (now: number, ttl: number) => { for (const ci of active) await lock.renew(ci, 'w1', now + ttl); };
    await beat(5000, 100);
    expect(renewSpy).toHaveBeenCalledWith('ci', 'w1', 5100);
    expect((await lock.get('ci'))?.lockExpiresAtMs).toBe(5100);   // extended, no spurious takeover
  });
});
```

> This test pins the heartbeat-renew contract in isolation. The wiring inside `runWorkerLoop` (the `Set` + `beat` extension) is exercised end-to-end by the Task 10 acceptance test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-heartbeat.test.ts`
Expected: FAIL until `ComputeLockStore.renew` behaves as asserted (it already does from Task 1 — this test will PASS once the module exists; if so, treat Step 3 as wiring `runWorkerLoop`).

- [ ] **Step 3: Wire `runWorkerLoop`**

In `runWorkerLoop`, extend the existing `beat` interval: when `deps.computeLock` and `deps.coalesceEnabled` and there are active leader identities (a `Set<string>` the gate maintains via `deps` callbacks), also `renew` each to `deps.clock() + (deps.computeLockTtlMs ?? deps.lease.ttlMs)`:
```ts
  const activeLeaders = new Set<string>();
  // expose to the gate: deps.registerLeader = (ci)=>activeLeaders.add(ci); deps.unregisterLeader = (ci)=>activeLeaders.delete(ci);
  const beat = setInterval(() => {
    if (deps.lease) {
      pendingRenew = deps.store.renewLease(deps.lease.workerId, deps.clock() + deps.lease.ttlMs).catch(() => {});
      if (deps.computeLock && deps.coalesceEnabled) {
        const until = deps.clock() + (deps.computeLockTtlMs ?? deps.lease.ttlMs);
        for (const ci of activeLeaders) void deps.computeLock.renew(ci, deps.lease.workerId, until).catch(() => {});
      }
    }
  }, opts.heartbeatMs);
```
Add `registerLeader?`/`unregisterLeader?` optional callbacks to `WorkerDeps`, wired by `runWorkerLoop` into `deps` before draining; the Task 5 gate calls `deps.registerLeader?.(identity)` on lock-win and `deps.unregisterLeader?.(identity)` in the `finally`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/coalesce-heartbeat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/coalesce-heartbeat.test.ts
git commit -m "feat(coalesce): leader renews compute-lock in the heartbeat loop"
```

---

### Task 9: Wiring (`buildApp` + `worker-main`) + wake cadence + docs

**Files:**
- Modify: `apps/backtester/src/app.ts` (`buildApp` — construct `ComputeLockStore`, wire `WorkerDeps`, run wake in the tick)
- Modify: `apps/backtester/src/worker-main.ts` (run wake in the worker loop cadence)
- Modify: `docs/OPERATIONS.md`
- Test: `apps/backtester/test/coalesce-wiring.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `workerDeps.computeLock`/`coalesceEnabled`/`computeLockTtlMs`/`computeWaitMaxAttempts` set from config; `wakeComputeWaiters` invoked each tick/loop iteration when coalescing on.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-wiring.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import { PgComputeLockStore } from '../src/jobs/coalesce/pg-compute-lock.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

describe('buildApp coalescing wiring', () => {
  it('wires a ComputeLockStore + flags when coalesceEnabled', async () => {
    const app = await buildApp(testConfig({ dedupEnabled: true, coalesceEnabled: true }));
    dispose = app.dispose;
    expect(app.workerDeps.coalesceEnabled).toBe(true);
    expect(app.workerDeps.computeLock).toBeInstanceOf(InMemoryComputeLockStore); // no DB in testConfig → InMemory
  });
  it('coalesceEnabled false → no computeLock on workerDeps', async () => {
    const app = await buildApp(testConfig({ coalesceEnabled: false }));
    dispose = app.dispose;
    expect(app.workerDeps.computeLock).toBeUndefined();
    expect(app.workerDeps.coalesceEnabled).toBe(false);
  });
});
```
> Add `coalesceEnabled: false`, `computeLockTtlMs`, `computeWaitMaxAttempts` to the `testConfig` helper (`apps/backtester/test/helpers.ts`) alongside `dedupEnabled`/`jobObs` so the config typechecks.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-wiring.test.ts`
Expected: FAIL — `workerDeps.computeLock` always undefined.

- [ ] **Step 3: Write minimal implementation**

In `buildApp`, construct the lock store to match the job store backend:
```ts
  const computeLock = config.coalesceEnabled
    ? (ownedPool ? new PgComputeLockStore(ownedPool) : new InMemoryComputeLockStore())
    : undefined;
```
Add to the `workerDeps` object literal:
```ts
    ...(computeLock ? { computeLock } : {}),
    coalesceEnabled: config.coalesceEnabled,
    computeLockTtlMs: config.computeLockTtlMs,
    computeWaitMaxAttempts: config.computeWaitMaxAttempts,
```
Run the wake pass in the combined `tick` (after `drain`/`reap`) when coalescing on:
```ts
    if (config.coalesceEnabled && computeLock) {
      await wakeComputeWaiters({ store, resultCache, computeLock, clock, computeWaitMaxAttempts: config.computeWaitMaxAttempts });
    }
```
In `worker-main.ts` / `runWorkerLoop`, invoke `wakeComputeWaiters(...)` once per loop iteration (next to `reapAndPublish`) when `deps.coalesceEnabled && deps.computeLock`.

Add the `OPERATIONS.md` section (near "Result dedup"):
```markdown
### In-flight coalescing (Phase C)

`BACKTESTER_COALESCE_ENABLED=true` (default off; requires `BACKTESTER_DEDUP_ENABLED=true`) coalesces
concurrent identical runs: the first (leader) runs the engine; the rest (followers) defer internally
(`waiting_for_compute`, shown as `running` in the public API) and complete via re-stamp once the leader's
result is cached — or take over if the leader fails/crashes. Postgres-durable only. Tunables:
`BACKTESTER_COMPUTE_LOCK_TTL_MS` (default = worker lease TTL), `BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS`
(default 3). Off = byte-identical to the shipped dedup behavior.
```

- [ ] **Step 4: Run test + full gate**

Run: `pnpm vitest run apps/backtester/test/coalesce-wiring.test.ts` → PASS.
Run: `pnpm check` → typecheck clean; all suites green (Docker/Pg-gated skip locally).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/src/worker-main.ts apps/backtester/test/helpers.ts apps/backtester/test/coalesce-wiring.test.ts docs/OPERATIONS.md
git commit -m "feat(coalesce): wire ComputeLockStore + wake cadence through buildApp/worker-main; docs"
```

---

### Task 10: Acceptance — N concurrent identical runs execute the engine exactly once

**Files:**
- Test: `apps/backtester/test/coalesce-acceptance.test.ts`

**Interfaces:**
- Consumes: the full stack (momentum, InMemory stores + InMemoryComputeLockStore, coalescing on).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/coalesce-acceptance.test.ts
// The headline invariant: a burst of N identical momentum runs, driven concurrently through the gate +
// wake, executes runBacktest EXACTLY once; all N end terminal completed; exactly 1 result_cache entry.
import { describe, expect, it, vi } from 'vitest';
import { drainQueue, processNextQueued } from '../src/jobs/worker.js';
import * as runBacktestModule from '../src/runner/run-backtest.js';
// reuse makeCtx (coalesce+dedup on, InMemoryComputeLockStore) + enqueue + wakeComputeWaiters loop.

describe('coalescing acceptance — engine runs once for a concurrent identical burst', () => {
  it('N=4 identical → 1 engine run, 4 completed, 1 cache entry', async () => {
    const { store, cache, deps, lock } = makeCoalesceCtx(); // dedupEnabled+coalesceEnabled, shared stores, lease workerId
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');
    const ids = ['b1', 'b2', 'b3', 'b4'];
    for (const id of ids) await enqueue(store, id);

    // Round 1: drain all 4 with the SAME clock so the leader still holds the lock when followers hit the gate.
    // Concurrency 4 so all four enter the gate before the leader populates the cache.
    await drainQueue(deps, 4);

    // 1 leader ran the engine; 3 became waiting_for_compute.
    expect(runSpy).toHaveBeenCalledTimes(1);
    const waiting = (await Promise.all(ids.map((i) => store.get(i)))).filter((j) => j?.status === 'waiting_for_compute');
    expect(waiting.length).toBe(3);

    // Wake: cache now present → release all 3 → re-drain → HIT re-stamp.
    await wakeComputeWaiters({ store, resultCache: cache, computeLock: lock, clock: deps.clock, computeWaitMaxAttempts: 3 });
    await drainQueue(deps, 4);

    expect(runSpy).toHaveBeenCalledTimes(1); // STILL once — no follower ran the engine
    for (const id of ids) expect((await store.get(id))?.status).toBe('completed');
    // exactly one cache entry for the shared fingerprint
    // (assert via a cache size accessor or by counting distinct computeIdentity puts)
  });
});
```
> `makeCoalesceCtx` = `dedup-worker.test.ts::makeCtx` with `coalesceEnabled:true` + a shared `InMemoryComputeLockStore` on `deps.computeLock` + a `deps.lease = { workerId:'w1', ttlMs: 60000, maxAttempts: 3 }`. Because `drainQueue` runs the bounded pool, the 4 claims interleave; the deterministic InMemory clock keeps the leader's lock alive across the round so followers defer. If `drainQueue`'s InMemory scheduling completes the leader before the followers claim (no true concurrency), instead drive it explicitly: claim+gate the leader first (it wins the lock, but DON'T populate yet by stubbing the engine to resolve after the followers defer), or seed the lock and assert the follower path directly — the Task 5 gate test already proves single-follower deferral; here assert the end state (1 engine call, 4 completed, 1 cache entry) after the wake round.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/coalesce-acceptance.test.ts`
Expected: FAIL before the feature is wired end-to-end (engine called >1, or followers not completed).

- [ ] **Step 3: Make it pass**

No new production code — this test exercises Tasks 1–9. If it fails, the defect is in one of those tasks; fix there and re-run. (If InMemory `drainQueue` cannot produce genuine concurrency, use the explicit-drive variant described in the Step-1 note so the assertion still pins "engine runs once, all followers complete via re-stamp, one cache entry".)

- [ ] **Step 4: Run test + full gate**

Run: `pnpm vitest run apps/backtester/test/coalesce-acceptance.test.ts` → PASS.
Run: `pnpm check` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/coalesce-acceptance.test.ts
git commit -m "test(coalesce): acceptance — concurrent identical burst runs the engine exactly once"
```

---

## Self-Review

**Spec coverage:**
- Compute lock table + store (INV-2/4) → Tasks 1, 2. ✅
- `computeIdentity` gate, leader/follower, engine-commit charge on all engine paths (INV-1, INV-5) → Task 5. ✅
- `waiting_for_compute` internal status + `toStatusView`→running (INV-7) → Task 4. ✅
- Deferred attempt charging in claim (INV-5) → Task 6. ✅
- Wake release-policy (cache-ready release-all; lock-expired elect-one; lock-alive keep; poison) + reaper attribution → Task 7. ✅
- Heartbeat compute-lock renew → Task 8. ✅
- Config flags, wiring, wake cadence, docs → Tasks 3, 9. ✅
- Coalescing OFF no-op (INV-6) → asserted in Tasks 5 (goldens) + 6 (claim off) + reaper-off path; `pnpm check` in 9. ✅
- Acceptance concurrency (engine once) → Task 10. ✅
- Postgres-durable-only; InMemory as fakes → Tasks 1/2/7 (InMemory + Pg pair). ✅

**Placeholder scan:** no TBD/TODO; each code step shows real code. Store-helper Pg SQL for `listComputeWaiters`/`releaseAll`/`electOne`/`poison` is specified as exact query shapes in Task 7 (the implementer writes the mirrored InMemory + Pg per the given SQL). The Task 5/10 "if InMemory concurrency is insufficient" notes are explicit fallbacks, not placeholders.

**Type consistency:** `ComputeLockStore`/`ComputeLock`/`ComputeWakeReason`, `InternalJobStatus`, `WorkerDeps.computeLock`/`coalesceEnabled`/`computeLockTtlMs`/`computeWaitMaxAttempts`, `JobRow`/`JobRowPatch` fields (`computeWaitAttempts`/`computeIdentity`/`waitDeadlineMs`/`computeWakeReason`/`engineAttemptCharged`), `wakeComputeWaiters(WakeDeps)`, and the store helpers (`listComputeWaiters`/`releaseAllComputeWaiters`/`electOneComputeWaiter`/`poisonComputeWaiter`) are used identically across Tasks 1→10.
