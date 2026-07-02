# In-flight request coalescing — design

**Date:** 2026-07-02
**Status:** design (pre-plan)
**Slice:** Phase C follow-up to result dedup (#73/#75) — the optimization the realistic-validation bottleneck read identified as next (fresh engine ~27s dominates; the completed-cache only helps *after* the first identical run finishes).

## Goal

When several **identical** jobs (same `computeIdentity`) reach workers before the first one finishes, only one — the **leader** — runs the engine/sandbox. The rest — **followers** — do NOT run the engine and do NOT hold a worker slot: they defer to a new `waiting_for_compute` status, release the slot, and complete via re-stamp once the leader's `result_cache` template appears (or take over if the leader fails/crashes).

This closes the window the completed-result cache leaves open: the cache helps only *after* the first run completes; a concurrent burst of duplicates arriving *before* the first lands would each pay the full ~15–44s engine cost today.

## Non-goals (YAGNI — explicit)

- No change to the shipped `backtest_result_cache` / `ResultCache` contract — it stays **completed-templates only** (no `in_progress` state).
- No submit-time / API change — coalescing is worker-time, keyed on the same `computeIdentity` as the completed-cache, validated after materialize.
- No InMemory production path — coalescing is **Postgres-durable only**; InMemory is a test fake / minimal model for unit tests.
- No reduction of the fresh-engine cost itself (sandbox warm-pool) — deferred, security-sensitive.
- No new sandbox policy / output-quota change (the `sandbox_output_overflow` follow-up is separate).
- No priority scheduler — promoted waiters keep their original FIFO position (see §Promotion), nothing more.

## Current-state grounding (from code)

- `processNextQueued` (`apps/backtester/src/jobs/worker.ts`) claims a `queued` job → `running` (with a job-lease `lease_expires_at` + `attempts++`), materializes (→ `datasetFingerprint`), then the **dedup gate**: `computeIdentity = sha256(requestFingerprint + datasetFingerprint + DEDUP_COMPUTE_VERSION + sandboxPolicyVersion)`; on a completed-cache HIT it re-stamps, on MISS it runs the engine and populates `result_cache` on success only.
- Job lifecycle: `RunStatus` transitions gated by `lifecycle.ts::canTransition`; the reaper (`reapDeadlines`) handles `queued→expired` (queue deadline), `running→failed` (`lease_expired`, poison at `attempts>=cap`), `running→queued` (requeue at `attempts<cap`), `running→timed_out` (run deadline). Claim = `WHERE status='queued' … FOR UPDATE SKIP LOCKED` + `attempts = attempts+1` when a lease workerId is present.
- The horizontal-worker loop already has a heartbeat cadence (`heartbeatMs`) that renews the job-lease; and workers carry a `lease.workerId` identity in Postgres mode.

The compute-lock reuses **exactly this lease/SKIP-LOCKED/reaper idiom**, applied to `computeIdentity` instead of a job row.

## Decisions (all user-adjudicated during brainstorming)

1. **Worker-time, post-materialize**, keyed on `computeIdentity`. Leader and followers both pay materialize (~sub-second); only the engine phase is coalesced.
2. **Follower model = new non-terminal status `waiting_for_compute`** (releases the worker slot). NOT in-process bounded wait; NOT requeue-on-detect (which collides with `attempts`/poison + FIFO).
3. **Coordination = a separate `backtest_compute_lock` table**, expiry-based, leader election via upsert, `takeover` on expiry, `proactive-expire` on the leader's explicit terminal fail/timeout. `result_cache` is untouched.
4. **Promotion = "A"**: a wake/reap step selects waiters back to `queued` with a `compute_wake_reason`; the promoted waiter re-enters the normal `claim → materialize → gate` path and the leader is (re-)elected by the compute-lock there — the wake step never builds engine context itself.
5. **Scope = Postgres-durable only**; InMemory = test fake.
6. **Flag** `BACKTESTER_COALESCE_ENABLED` (default OFF, dark-launch, same pattern as `BACKTESTER_DEDUP_ENABLED`), **requires `dedupEnabled=true`** (coalescing shares the `computeIdentity` machinery and only makes sense with the completed-cache on).

## Invariants (binding — a reviewer checks these verbatim)

- **INV-1 — cache success wins over lock.** The gate/wake read order is always `result_cache.lookup(computeIdentity)` FIRST, then `compute_lock`. A present template completes the follower via re-stamp even if the lock is not yet cleared/expired.
- **INV-2 — lock expiry alone is not failure.** An expired lock means "the leader no longer owns compute"; it only allows takeover — it never fails any follower.
- **INV-3 — a waiting-follower completes byte-identically to a normal HIT run** (own `runId`/`result_hash`, `dedupedFrom` set), through the existing completion/outbox path. No separate completion code.
- **INV-4 — lock cleanup is not correctness-critical.** If the success path wrote the template but did not release/expire the lock, followers still see the cache first (INV-1) and complete; a stale lock is harmless and expires naturally.
- **INV-5 — attempts accounting.** engine `attempts` counts ONLY real engine/sandbox runs (leadership executions). A separate `compute_wait_attempts` counts wait/re-election cycles. A `promoted` re-claim that resolves back into `waiting_for_compute` (someone else already leads) bumps `compute_wait_attempts`, NOT engine `attempts`. engine `attempts` is spent only when the gate actually executes the engine as leader.
- **INV-6 — coalescing OFF is a no-op.** With `BACKTESTER_COALESCE_ENABLED` off (default): NO `compute_lock` reads/writes, NO `waiting_for_compute` transitions, completed-cache behavior exactly as shipped (#73/#75), `attempts` semantics unchanged. The existing dedup goldens / byte-equivalence hold unchanged.

## Components

### DB (migration `0005_compute_lock.sql`)

**New table `backtest_compute_lock`** — one row per in-flight `computeIdentity`:
```sql
CREATE TABLE IF NOT EXISTS backtest_compute_lock (
  compute_identity     TEXT   PRIMARY KEY,
  leader_run_id        TEXT   NOT NULL,
  lock_owner_worker_id TEXT   NOT NULL,
  lock_expires_at_ms   BIGINT NOT NULL,
  created_at_ms        BIGINT NOT NULL,
  updated_at_ms        BIGINT NOT NULL
);
```

**`backtest_job` new columns:**
```sql
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wait_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_identity      TEXT;      -- set when the job defers; lets wake match it
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS wait_deadline_ms      BIGINT;    -- max time a follower may wait before re-election
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wake_reason   TEXT;      -- why a waiter was released: cache_ready | lock_expired | leader_failed
```

### `ComputeLockStore` (sibling to `ResultCache`)

Interface + `PgComputeLockStore` + `InMemoryComputeLockStore` (test fake):
- `acquire(computeIdentity, leaderRunId, workerId, nowMs, ttlMs): Promise<boolean>` — wins iff no row OR the existing row is expired (`nowMs > lock_expires_at_ms`). Implemented as
  `INSERT … ON CONFLICT (compute_identity) DO UPDATE SET leader_run_id=…, lock_owner_worker_id=…, lock_expires_at_ms=…, updated_at_ms=… WHERE backtest_compute_lock.lock_expires_at_ms < $now RETURNING compute_identity` → won iff a row is returned.
- `renew(computeIdentity, workerId, untilMs): Promise<void>` — extends `lock_expires_at_ms` only while `lock_owner_worker_id = workerId`.
- `expire(computeIdentity, workerId, nowMs): Promise<void>` — proactive-expire (`lock_expires_at_ms = nowMs`) only while owner matches; called on the leader's terminal fail/timeout.
- (Optional `release` on success = cleanup only; not correctness-critical per INV-4.)

### Lifecycle / status

- `RunStatus += 'waiting_for_compute'` (non-terminal) in `@trading/research-contracts`.
- `lifecycle.ts::canTransition` adds: `running → waiting_for_compute`, `waiting_for_compute → queued` (wake), `waiting_for_compute → failed` (poison, `compute_wait_exhausted`).

### Gate (`processNextQueued`)

After materialize + `computeIdentity`, keep the existing `result_cache.lookup` FIRST (INV-1). Only when `BACKTESTER_COALESCE_ENABLED` and it's a MISS:
- `computeLock.acquire(computeIdentity, runId, workerId, now, ttl)`:
  - **won → leader**: run the engine (existing path). On success: write `result_cache` template (existing) + best-effort `release`/`expire` lock. On terminal fail/timeout: `computeLock.expire(...)` (proactive), then the normal terminal transition.
  - **lost (active lock held) → follower**: transition `running → waiting_for_compute`, persist `compute_identity` + `wait_deadline_ms = now + waitTtl`; the worker loop moves on (slot freed). No engine, no `attempts` bump.

### Wake / reap step `wakeComputeWaiters(nowMs)` (store method, run at the reaper cadence)

For `waiting_for_compute` jobs, grouped by `compute_identity`:
- **cache present** (`result_cache` has the template) → release **ALL** waiters of that identity → `queued`, `compute_wake_reason='cache_ready'` (original `queued_at_ms` preserved). They re-claim → completed-cache HIT → re-stamp (INV-3).
- **lock expired / absent AND no cache** → elect **exactly ONE** waiter (`… WHERE run_id = (SELECT … status='waiting_for_compute' AND compute_identity=$ci … FOR UPDATE SKIP LOCKED LIMIT 1)`) → `queued`, reason = `leader_failed` if the `leader_run_id` job is in a terminal fail/timeout/canceled state, else `lock_expired` (natural expiry / crash). The rest stay waiting. The promoted one re-enters the gate and wins the (now-free) lock → new leader.
- **lock alive AND no cache** → keep waiting.
- **`compute_wait_attempts >= cap`** → poison: `waiting_for_compute → failed`, `terminal_code='compute_wait_exhausted'`.
- **`wait_deadline_ms` exceeded** with lock still alive → treat as eligible for re-election (bump `compute_wait_attempts`, release as `lock_expired`) — NOT auto-fail (INV-2). Bounded by the poison cap. This is a safety re-check, not a forced takeover: the released waiter re-enters the gate and re-contends via `computeLock.acquire`, which **fails while the lock is alive** → the waiter re-defers to `waiting_for_compute`. So a slow-but-live leader can never be double-computed — the acquire is the single authoritative leadership gate. (Default the wait TTL ≥ the lock TTL so natural expiry-driven takeover fires first and the wait_deadline only catches genuinely stuck waiters.)

### Claim path (`compute_wake_reason` awareness)

`claimNextQueued` continues to claim `queued` jobs. A claimed job carrying `compute_wake_reason` re-runs materialize + gate. The **`attempts` bump moves to reflect INV-5**: a claim whose gate resolves back into `waiting_for_compute` must not spend an engine `attempt` — instead bump `compute_wait_attempts`. Concretely: for a `compute_wake_reason`-marked claim, defer the `attempts` increment until the gate commits to running the engine as leader; if it re-defers, increment `compute_wait_attempts` and clear the marker. (Plain, unmarked jobs keep the existing claim-time `attempts++`.)

### Config / heartbeat

- `BACKTESTER_COALESCE_ENABLED` (default false) — `env.BACKTESTER_COALESCE_ENABLED === 'true'`; effective only when `dedupEnabled` is also true.
- `BACKTESTER_COMPUTE_LOCK_TTL_MS` (default: the worker lease TTL) — the compute-lock lifetime; the leader **renews it in the existing heartbeat loop, separately from the job-lease**, so a long engine run never lets the lock lapse and trigger a spurious takeover. Coalescing requires a `workerId`/lease identity (present in Postgres-durable mode).
- A follower wait TTL (`wait_deadline_ms` horizon) — default a small multiple of the lock TTL.

## Data flow

- **Burst of N identical, dedup+coalesce on:** 1 `acquire` wins (leader), N−1 lose → `waiting_for_compute` (slots freed). Leader engine → success → template in `result_cache`. Next wake pass: cache present → release all N−1 → `queued(cache_ready)` → re-claim → HIT re-stamp → `completed`. **Net: engine ran exactly once, exactly 1 cache entry, all N `completed`.** ← the headline acceptance test.
- **Leader fail/timeout** (before populate): leader `expire`s the lock (proactive) → wake elects 1 (`leader_failed`) → new leader runs engine; rest wait. Serialized recovery, no group-wide failure (INV-2).
- **Leader crash** (process died, no proactive signal): lock lapses at TTL exactly like a dead worker-lease → wake elects 1 (`lock_expired`). Note: the crashed leader's own job is independently requeued by the existing lease reaper; it and the promoted follower both re-contend the single compute-lock → exactly one leader (the lock is the sole leadership source of truth).
- **Cleanup partial failure:** template written, lock not released → INV-1 (cache-first) still completes followers; stale lock expires later (INV-4).

## Testing

- **`ComputeLockStore` unit** (Pg-gated + InMemory): acquire wins on empty/expired, loses on active; renew extends only for owner; expire only for owner; takeover after expiry; first-writer-wins under contention.
- **Gate**: won → leader runs engine (spy); lost → `waiting_for_compute`, engine NOT called, slot released, no `attempts` bump.
- **Wake**: cache-present → release ALL (`cache_ready`); lock-expired-no-cache → elect exactly ONE (`lock_expired`/`leader_failed` by leader job state); lock-alive → keep; `compute_wait_attempts>=cap` → `failed(compute_wait_exhausted)`.
- **INV-5 attempts**: a promoted claim that re-defers bumps `compute_wait_attempts` not `attempts`; a leader engine run bumps `attempts`.
- **Failure**: leader fail → proactive-expire → 1 promoted → engine; leader success → all followers re-stamp (`dedupedFrom` set, `completed`, INV-3).
- **Acceptance concurrency** (the headline): N concurrent identical submissions → engine executes EXACTLY once, 1 `result_cache` entry, all N terminal `completed` with distinct runId-stamped `result_hash`.
- **INV-6 OFF**: coalescing off → no `compute_lock` rows touched, no `waiting_for_compute` transitions, the dedup goldens + completed-cache behavior byte-identical.

## Acceptance

- With `BACKTESTER_DEDUP_ENABLED=true BACKTESTER_COALESCE_ENABLED=true`, a burst of N concurrent identical jobs runs the engine exactly once; N−1 complete via re-stamp without ever running the engine or holding a slot for the leader's engine duration.
- Leader failure/crash never fails the follower group; exactly one new leader is elected; recovery is bounded by the compute-lock TTL (proactive-expire makes explicit failure immediate).
- `attempts`/poison semantics for real engine runs are unchanged; wait cycles are bounded by a separate `compute_wait_attempts` cap.
- Coalescing off (default) is a proven no-op over the shipped dedup behavior.

## Follow-ups (out of this slice)

- Explicit leader→follower wake signal (LISTEN/NOTIFY) to cut wake latency below the reaper cadence.
- Coalescing in the combined `AUTO_WORKER` single-process topology (today: Postgres-durable split only).
- Priority lane for promoted waiters (beyond preserving `queued_at_ms`).
- Metrics: coalesced-count / leader-failovers surfaced through the job-observability `/statsz` (`BACKTESTER_JOB_OBS`).
