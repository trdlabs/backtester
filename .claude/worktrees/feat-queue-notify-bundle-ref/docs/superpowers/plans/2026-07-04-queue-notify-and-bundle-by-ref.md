# Queue-Wake (LISTEN/NOTIFY) + Bundle-by-Ref Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Postgres LISTEN/NOTIFY worker wake (flag-gated, latency-only) and an HTTP bundle-by-ref path (upload once, submit by hash) — Phase D item 16 tails — in one PR.

**Architecture:** Part A adds a `QueueWaker` that owns a dedicated `LISTEN` connection and resolves the worker's idle wait on a `pg_notify` emitted whenever a job becomes claimable (submit-enqueue transition + reap requeue). Polling stays as the correctness backstop; the waker degrades to a plain timeout when the flag is off or the store is InMemory. Part B exposes the already content-addressed `BundleStore` over `POST /v1/bundles` + `HEAD /v1/bundles/:hash`, teaches `submitRun` to accept a `bundleRef`, and folds the bundle content-hash into `requestFingerprint` so inline and by-ref submits share one dedup identity.

**Tech Stack:** TypeScript, Fastify, node-`pg`, vitest. Repo: `trading-backtester` (`apps/backtester` service + `packages/sdk`).

## Global Constraints

- **Determinism untouched.** `result_hash` and `computeIdentity` unchanged. Bundle-by-ref MUST be fingerprint-invariant: `requestFingerprint(inline X) === requestFingerprint(bundleRef = hash(X))`.
- **NOTIFY is latency-only.** `pollMs` stays the guaranteed backstop. Flag OFF or InMemory store ⇒ worker behavior byte-for-byte today's. A lost/late notification is bounded by `pollMs`.
- **Flag posture.** `BACKTESTER_QUEUE_NOTIFY` default **false**. The waker is constructed/used **only for `PgJobStore`** — InMemory uses a plain timeout even if the flag is on. Bundle-by-ref is additive, **no flag**.
- **`result_hash` is runId-stamped.** For two distinct runIds (a duplicate run, NOT a resumeToken replay) the hashes MUST differ. A dedup HIT skips the engine (`engineMs: null`, `deduped_from` set) and re-stamps the payload for its own runId. Prove compute equivalence via the normalize/restamp golden pattern, never by comparing two runs' raw `result_hash`.
- **SDK hygiene.** Public `.d.ts` free of Node globals (`Buffer`). SDK version bump = 4 sites (`package.json`, `src/internal/versions.ts` `SDK_VERSION`, `package-shape.test`, `registry-contract.test`); release workflow asserts `package.json` == input.
- **Idempotency.** Any SDK retry (incl. bundle self-healing) reuses the **same `resumeToken`** — never a duplicate run.
- **Commands.** Service tests: `pnpm test <file>` (run from the repo/worktree ROOT — the root package's `test` script is `vitest run`). Do NOT use `pnpm --filter @trading-backtester/service test …` — that package has no `test` script, so pnpm silently no-ops and exits 0 (looks green, runs nothing). SDK tests: `pnpm --filter @trading-backtester/sdk test <file>` (that package DOES have a `test` script). Typecheck: `pnpm -r check`.
- **Real test harness (use it — do NOT invent a `helpers-pg.ts`).** Postgres tests import `PG_AVAILABLE` / `STORE_FACTORIES` / `createPgSchema` / `DOCKER_AVAILABLE` from `test/store-factories.ts`, and `makeApp` / `runBody` / `AUTH` / `testConfig` from `test/helpers.ts`. Canonical patterns to copy verbatim: `queue-cap.test.ts` (`for (const factory of STORE_FACTORIES) { describe.skipIf(!factory.available)(...) }` + `makeApp(factory)` → `{ app, store, cleanup }` + HTTP `inject`), `pg-coalesce-wake.test.ts` (raw `createPool`+`migrate` per-schema + inline `newJob`/`seedWaiter` via `store.transition`), `s3-store.test.ts::makeBundle` (a `ModuleBundle` via `createModuleManifest` + `{ manifest, entry, files }`), `dedup-worker.test.ts` (dedup worker drain). The Pg env var is `BACKTESTER_TEST_DATABASE_URL ?? DATABASE_URL` (probed once in `store-factories.ts` → `PG_AVAILABLE`); NEVER hardcode a connection string in a test or a command — export the env var and run the command plainly. A green run where every Pg test *skipped* is NOT a pass for the Pg-gated tasks (A2/A3/A4/B5).

---

## Part A — LISTEN/NOTIFY queue-wake

### Task A1: Config flag + channel constant

**Files:**
- Modify: `apps/backtester/src/config.ts` (add `queueNotify` to `AppConfig` + `loadConfig`)
- Create: `apps/backtester/src/jobs/queue-notify-channel.ts` (shared channel constant)
- Test: `apps/backtester/test/config-queue-notify.test.ts`

**Interfaces:**
- Produces: `AppConfig.queueNotify: boolean`; `export const QUEUE_NOTIFY_CHANNEL = 'backtest_job_queued'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/config-queue-notify.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('queue-notify config', () => {
  it('defaults off', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).queueNotify).toBe(false);
  });
  it('true only for exact "true"', () => {
    expect(loadConfig({ BACKTESTER_QUEUE_NOTIFY: 'true' } as NodeJS.ProcessEnv).queueNotify).toBe(true);
    expect(loadConfig({ BACKTESTER_QUEUE_NOTIFY: '1' } as NodeJS.ProcessEnv).queueNotify).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test config-queue-notify`
Expected: FAIL (`queueNotify` undefined).

- [ ] **Step 3: Add the channel constant file**

```ts
// apps/backtester/src/jobs/queue-notify-channel.ts
/** Postgres LISTEN/NOTIFY channel for queue-wake. NOTIFY and LISTEN sides import this — never inline the literal. */
export const QUEUE_NOTIFY_CHANNEL = 'backtest_job_queued';
```

- [ ] **Step 4: Add the flag to config**

In `apps/backtester/src/config.ts`, add `readonly queueNotify: boolean;` to the `AppConfig` interface (near the other Phase-D flags like `barBatching`), and in `loadConfig`'s returned object add (mirroring the `=== 'true'` boolean pattern already used):

```ts
    queueNotify: env.BACKTESTER_QUEUE_NOTIFY === 'true',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test config-queue-notify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/src/jobs/queue-notify-channel.ts apps/backtester/test/config-queue-notify.test.ts
git commit -m "feat(queue-notify): BACKTESTER_QUEUE_NOTIFY flag (default off) + channel constant"
```

---

### Task A2: `QueueWaker` wake primitive

**Files:**
- Create: `apps/backtester/src/jobs/queue-notify.ts`
- Test: `apps/backtester/test/queue-notify.test.ts`

**Interfaces:**
- Consumes: `QUEUE_NOTIFY_CHANNEL` (A1).
- Produces:
  - `interface QueueWaker { waitForWake(pollMs: number, signal: AbortSignal): Promise<void>; whenReady(): Promise<void>; dispose(): Promise<void>; }`
  - `function createTimeoutWaker(): QueueWaker` — degraded (timeout-only) waker.
  - `function createPgQueueWaker(connectionString: string): QueueWaker` — dedicated `LISTEN` client with reconnect + `pendingWake` guard.

The `waitForWake` contract: resolves on the FIRST of — a notification received since the previous `waitForWake` returned (the `pendingWake` guard), a notification arriving during the wait, the `pollMs` timeout, or `signal` abort. Never rejects. Every `abort` listener it registers on the (long-lived) worker signal MUST be removed when the wait resolves — a listener leaked per idle wait accumulates unboundedly over the process lifetime. `whenReady()` resolves once the LISTEN connection is established (deterministic test synchronization — no fixed sleeps).

- [ ] **Step 1: Write the failing test (timeout waker + pendingWake semantics via a fake)**

```ts
// apps/backtester/test/queue-notify.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createTimeoutWaker } from '../src/jobs/queue-notify.js';

describe('createTimeoutWaker', () => {
  it('resolves on timeout', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    const t0 = Date.now();
    await w.waitForWake(30, ac.signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    await w.dispose();
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await w.waitForWake(10_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(200);
    await w.dispose();
  });

  it('resolves when the signal aborts mid-wait', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    const p = w.waitForWake(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await p;
    expect(Date.now() - t0).toBeLessThan(500);
    await w.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test queue-notify`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `queue-notify.ts`**

```ts
// apps/backtester/src/jobs/queue-notify.ts
import { Client } from 'pg';
import { QUEUE_NOTIFY_CHANNEL } from './queue-notify-channel.js';

export interface QueueWaker {
  /** Resolve on the first of: a pending/incoming notification, the pollMs timeout, or signal abort. Never rejects. */
  waitForWake(pollMs: number, signal: AbortSignal): Promise<void>;
  /** Resolves once the LISTEN connection is established (timeout waker: resolves immediately). */
  whenReady(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Wait for `ms`, or resolve early if `signal` aborts. Removes its abort listener on BOTH exits so a
 * long-lived signal (the worker loop's) does not accumulate a listener per idle wait.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(t); cleanup(); resolve(); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/** Degraded waker: plain timeout. Used when the flag is off or the store is InMemory. */
export function createTimeoutWaker(): QueueWaker {
  return {
    waitForWake: (pollMs, signal) => sleep(pollMs, signal),
    whenReady: async () => {},
    dispose: async () => {},
  };
}

/**
 * Pg LISTEN waker. Owns ONE dedicated connection (a LISTEN connection is monopolized — never from the pool).
 * `pendingWake` closes the lost-wakeup window: a NOTIFY that lands between drains sets the flag, and the next
 * `waitForWake` returns immediately instead of sleeping. Reconnect is bounded; while disconnected the caller
 * still gets a plain `pollMs` timeout, so polling backstops correctness.
 */
export function createPgQueueWaker(connectionString: string): QueueWaker {
  let client: Client | undefined;
  let pendingWake = false;
  let wake: (() => void) | undefined; // resolves the in-flight waitForWake, if any
  let disposed = false;
  let markReady!: () => void;
  const readyOnce = new Promise<void>((res) => { markReady = res; }); // resolves on FIRST successful LISTEN

  const onNotify = (): void => { pendingWake = true; wake?.(); };

  const connect = async (forceWake: boolean): Promise<void> => {
    if (disposed) return;
    const c = new Client({ connectionString });
    c.on('notification', onNotify);
    c.on('error', () => { void reconnect(); });
    c.on('end', () => { if (!disposed) void reconnect(); });
    await c.connect();
    await c.query(`LISTEN ${QUEUE_NOTIFY_CHANNEL}`);
    client = c;
    markReady(); // whenReady() resolvers fire once; subsequent reconnects are no-ops on the promise
    // On RECONNECT only, force one re-drain: NOTIFYs emitted while the listener was down were missed.
    // On the INITIAL connect the worker loop's first drain already covers startup, so no forced wake —
    // keeping tests deterministic (nothing to drain before the real NOTIFY).
    if (forceWake) onNotify();
  };

  let backoffMs = 100;
  const reconnect = async (): Promise<void> => {
    if (disposed) return;
    try { await client?.end(); } catch { /* already gone */ }
    client = undefined;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 5_000);
    try { await connect(true); backoffMs = 100; } catch { void reconnect(); }
  };

  const started = connect(false).catch(() => { void reconnect(); });

  return {
    whenReady: () => readyOnce,
    async waitForWake(pollMs, signal) {
      await started;
      if (pendingWake) { pendingWake = false; return; }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => { wake = undefined; clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
        wake = done;
        const t = setTimeout(done, pollMs);
        signal.addEventListener('abort', done);
      });
      pendingWake = false;
    },
    async dispose() {
      disposed = true;
      wake?.();
      try { await client?.end(); } catch { /* already gone */ }
      client = undefined;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test queue-notify`
Expected: PASS (3 tests).

- [ ] **Step 5: Add a Pg-gated test for the real LISTEN/NOTIFY round-trip**

Append to `apps/backtester/test/queue-notify.test.ts`. Guard/connect via the real harness — `PG_AVAILABLE` + the `PG_URL` expression from `store-factories.ts` (`BACKTESTER_TEST_DATABASE_URL ?? DATABASE_URL`). `whenReady()` makes it deterministic (no fixed sleep, and — with force-wake now reconnect-only — nothing to pre-drain):

```ts
import { Client } from 'pg';
import { createPgQueueWaker } from '../src/jobs/queue-notify.js';
import { QUEUE_NOTIFY_CHANNEL } from '../src/jobs/queue-notify-channel.js';
import { PG_AVAILABLE } from './store-factories.js';

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
describe.skipIf(!PG_AVAILABLE)('createPgQueueWaker (Pg)', () => {
  it('wakes on NOTIFY well before the pollMs timeout', async () => {
    const w = createPgQueueWaker(PG_URL);
    const ac = new AbortController();
    await w.whenReady(); // LISTEN established; no initial forced wake to drain
    const notifier = new Client({ connectionString: PG_URL });
    await notifier.connect();
    const t0 = Date.now();
    const p = w.waitForWake(10_000, ac.signal);
    setTimeout(() => void notifier.query(`SELECT pg_notify('${QUEUE_NOTIFY_CHANNEL}', '')`), 50);
    await p;
    expect(Date.now() - t0).toBeLessThan(2_000); // woke on NOTIFY, not the 10s poll
    await notifier.end();
    await w.dispose();
  });
});
```

- [ ] **Step 6: Run it (against a real Postgres) and commit**

Export your Postgres URL first (never hardcode it): `export DATABASE_URL=…` (or `BACKTESTER_TEST_DATABASE_URL`). Then:
Run: `pnpm test queue-notify`
Expected: PASS (4 tests with a DB reachable; the Pg one skips — not fails — without).

```bash
git add apps/backtester/src/jobs/queue-notify.ts apps/backtester/test/queue-notify.test.ts
git commit -m "feat(queue-notify): QueueWaker (Pg LISTEN + reconnect + pendingWake) and timeout waker"
```

---

### Task A3: Emit `pg_notify` on every enqueue

**Files:**
- Modify: `apps/backtester/src/jobs/pg-job-store.ts` (`transition` queued-hook + `reapDeadlines` requeue-hook + private `notifyQueued`)
- Test: `apps/backtester/test/queue-notify-emit-pg.test.ts`

**Interfaces:**
- Consumes: `QUEUE_NOTIFY_CHANNEL` (A1).
- Produces: `PgJobStore` emits `pg_notify(QUEUE_NOTIFY_CHANNEL, '')` after (a) a successful `transition(_, 'queued', …)` and (b) any row requeued to `queued` in `reapDeadlines`. No public signature change.

**Context:** `claimNextQueued` selects only `status = 'queued'`. Two enqueue sources make a job claimable: the submit-path `transition('accepted','queued', …)` (submitRun) and the two bulk `UPDATE … SET status='queued'` requeues inside `reapDeadlines` (coalescing requeue + attempts-based requeue). Both must notify. Anchor on the queued write, NOT the `accepted` insert (notifying at `accepted` wakes the worker before `claimNextQueued` can see the job — a racy lost-wakeup).

- [ ] **Step 1: Write the failing Pg-gated test**

```ts
// apps/backtester/test/queue-notify-emit-pg.test.ts
// Real harness: createPgSchema() (store-factories) for a migrated Pg store; inline newJob (mirrors
// pg-coalesce-wake.test.ts); a raw pg Client on PG_URL to LISTEN.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_AVAILABLE, createPgSchema } from './store-factories.js';
import { QUEUE_NOTIFY_CHANNEL } from '../src/jobs/queue-notify-channel.js';
import type { JobStore, NewJob } from '../src/jobs/job-store.js';

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
const newJob = (runId: string): NewJob => ({
  jobId: runId, runId, requestFingerprint: `fp-${runId}`, request: {} as never,
  effectiveSeed: 1, datasetRef: 'ds', runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
});

describe.skipIf(!PG_AVAILABLE)('PgJobStore enqueue NOTIFY', () => {
  let schema: Awaited<ReturnType<typeof createPgSchema>>;
  let store: JobStore;
  beforeAll(async () => { schema = await createPgSchema(); store = schema.makeStore(); });
  afterAll(async () => { await schema.teardown(); });

  it('fires on the accepted→queued transition', async () => {
    const listener = new Client({ connectionString: PG_URL });
    await listener.connect();
    await listener.query(`LISTEN ${QUEUE_NOTIFY_CHANNEL}`);
    const got = new Promise<void>((res) => listener.on('notification', () => res()));

    await store.insertOrGet(newJob('emit-a'));            // status 'accepted'
    await store.transition('emit-a', 'accepted', 'queued', { atMs: 1, queuedAtMs: 1 }); // → NOTIFY

    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error('no NOTIFY')), 2_000))]);
    await listener.end();
  });
});
```

> Note: `createPgSchema()` returns `{ makeStore, teardown }` (a fresh migrated schema); `newJob` mirrors the inline factory in `pg-coalesce-wake.test.ts`. No `helpers-pg.ts` — the harness already exists.

- [ ] **Step 2: Run test to verify it fails**

With `DATABASE_URL` exported: `pnpm test queue-notify-emit-pg`
Expected: FAIL (`no NOTIFY` — no emit yet).

- [ ] **Step 3: Add the helper + hooks in `pg-job-store.ts`**

Import the channel at the top: `import { QUEUE_NOTIFY_CHANNEL } from './queue-notify-channel.js';`

Add a private method:

```ts
  /** Wake listening workers: a job just became claimable. Best-effort — a lost NOTIFY only costs poll latency. */
  private async notifyQueued(): Promise<void> {
    await this.pool.query(`SELECT pg_notify($1, '')`, [QUEUE_NOTIFY_CHANNEL]);
  }
```

In `transition`, after `const r = await this.pool.query(...)` and before `return r.rowCount === 1;`:

```ts
    if (to === 'queued' && r.rowCount === 1) await this.notifyQueued();
```

In `reapDeadlines`, count requeued rows and notify once if any. Declare a counter in the method scope (before the `if (coalesceEnabled)` block):

```ts
    let requeued = 0;
```

The coalescing requeue lives inside `if (coalesceEnabled) { … }`; change its bare `await this.pool.query(<requeue UPDATE>)` to capture the result and add to the counter:

```ts
      const coalesceRequeue = await this.pool.query(/* the running→queued, compute_wait_attempts+1 UPDATE */);
      requeued += coalesceRequeue.rowCount ?? 0;
```

The attempts-based requeue is the unconditional `await this.pool.query(<running→queued under cap>)`; capture it likewise:

```ts
    const attemptsRequeue = await this.pool.query(/* the attempts<cap running→queued UPDATE */);
    requeued += attemptsRequeue.rowCount ?? 0;
```

Then, after the `timedOut` query and before `return`:

```ts
    if (requeued > 0) await this.notifyQueued();
```

- [ ] **Step 4: Run test to verify it passes**

With `DATABASE_URL` exported: `pnpm test queue-notify-emit-pg`
Expected: PASS.

- [ ] **Step 5: Guard against regressions — Pg suites still green**

With `DATABASE_URL` exported: `pnpm test pg-coalesce-wake pg-compute-lock dedup-result-cache queue-cap`
Expected: existing Pg tests PASS (notify is additive — no behavior change to transitions/requeues).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/queue-notify-emit-pg.test.ts
git commit -m "feat(queue-notify): pg_notify on submit-enqueue transition and reap requeue"
```

---

### Task A4: Wire the waker into the worker loop + Pg-gated wake integration + OPERATIONS

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`runWorkerLoop` idle wait → `waker.waitForWake`)
- Modify: `apps/backtester/src/worker-main.ts` (construct one waker/process, dispose on shutdown)
- Modify: `apps/backtester/src/app.ts` (expose a waker factory decision to worker-main, or construct in worker-main from config + store type)
- Modify: `docs/OPERATIONS.md` (NOTIFY section)
- Test: `apps/backtester/test/queue-notify-wake-pg.test.ts`

**Interfaces:**
- Consumes: `QueueWaker` (A2), `AppConfig.queueNotify` (A1), the emit side (A3).
- Produces: `runWorkerLoop` accepts `opts.waker?: QueueWaker` and uses `waker.waitForWake(pollMs, signal)` for the idle wait (falling back to the inline timeout when absent, preserving today's behavior).

- [ ] **Step 1: Write the failing Pg-gated integration test**

```ts
// apps/backtester/test/queue-notify-wake-pg.test.ts
// A worker with a high pollMs must still claim a freshly-enqueued job quickly — proving NOTIFY woke it.
// Enqueue via the STORE (insertOrGet + transition→queued) so ONLY the NOTIFY path can wake the loop
// (an HTTP submit would also call deps.kick()). The job need not complete — leaving 'queued' proves the wake.
import { describe, expect, it } from 'vitest';
import { PG_AVAILABLE, STORE_FACTORIES } from './store-factories.js';
import { makeApp } from './helpers.js';
import { runWorkerLoop } from '../src/jobs/worker.js';
import { createPgQueueWaker } from '../src/jobs/queue-notify.js';
import type { NewJob } from '../src/jobs/job-store.js';

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
const pgFactory = STORE_FACTORIES.find((f) => f.name === 'postgres')!;
const newJob = (runId: string): NewJob => ({
  jobId: runId, runId, requestFingerprint: `fp-${runId}`, request: {} as never,
  effectiveSeed: 1, datasetRef: 'ds', runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
});

describe.skipIf(!PG_AVAILABLE)('NOTIFY wake integration', () => {
  it('claims a fresh enqueue far faster than the 10s poll', async () => {
    const { app, store, cleanup } = await makeApp(pgFactory, {}, { queueNotify: true });
    const waker = createPgQueueWaker(PG_URL);
    const ac = new AbortController();
    await waker.whenReady();
    const loop = runWorkerLoop(app.workerDeps, { concurrency: 1, heartbeatMs: 1_000, pollMs: 10_000, signal: ac.signal, waker });
    await new Promise((r) => setTimeout(r, 300)); // let the loop reach its first idle wait

    const t0 = Date.now();
    await store.insertOrGet(newJob('wake-a'));
    await store.transition('wake-a', 'accepted', 'queued', { atMs: 1, queuedAtMs: 1 }); // emits NOTIFY
    for (let i = 0; i < 40 && (await store.get('wake-a'))?.status === 'queued'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await store.get('wake-a'))?.status).not.toBe('queued'); // claimed
    expect(Date.now() - t0).toBeLessThan(3_000);                    // via NOTIFY, not the 10s poll

    ac.abort(); await loop; await waker.dispose(); await cleanup();
  });
});
```

> Note: `makeApp(pgFactory, {}, { queueNotify: true })` → `{ app, store, cleanup }`; `app.workerDeps` is the same handle `worker-main.ts` runs the loop on. Enqueuing via `store` (not HTTP) isolates the NOTIFY wake from the in-process `kick()`. `makeApp`'s third arg is a `Partial<AppConfig>` override (here just to keep intent explicit — the waker under test is constructed directly, not from config).

- [ ] **Step 2: Run test to verify it fails**

With `DATABASE_URL` exported: `pnpm test queue-notify-wake-pg`
Expected: FAIL (`runWorkerLoop` ignores `waker`; job claimed only after the 10s poll → assertion fails, or a type error on `waker`).

- [ ] **Step 3: Use the waker in `runWorkerLoop`**

In `worker.ts`, add `waker?: import('./queue-notify.js').QueueWaker` to the `opts` param type of `runWorkerLoop`. Replace the idle-wait block:

```ts
      if (processed === 0) {
        if (opts.waker) {
          await opts.waker.waitForWake(opts.pollMs, opts.signal);
        } else {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, opts.pollMs);
            opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      }
```

- [ ] **Step 4: Run integration test to verify it passes**

With `DATABASE_URL` exported: `pnpm test queue-notify-wake-pg`
Expected: PASS (job claimed < 3s despite pollMs=10s).

- [ ] **Step 5: Construct one waker per worker process in `worker-main.ts`**

In `main()` (worker-main.ts), after `buildApp` and before the loop, choose the waker by store type + flag:

```ts
  const usePgWaker = config.queueNotify && config.databaseUrl !== undefined && deps.store instanceof PgJobStore;
  const waker = usePgWaker ? createPgQueueWaker(config.databaseUrl!) : createTimeoutWaker();
```

Pass `waker` into the `runWorkerLoop(..., { …, waker })` opts. In `shutdown()`, after `await loop;`, add `await waker.dispose();` (before or after `app.dispose()` — the waker owns its own connection). Add imports for `createPgQueueWaker`, `createTimeoutWaker`, and `PgJobStore`. (If `config.databaseUrl` is not already a field, use the same source `buildApp` uses to decide the Pg store; the `instanceof PgJobStore` check is the authoritative gate — the flag alone never creates a Pg waker on an InMemory store.)

- [ ] **Step 6: Verify no regression to the default (no-waker / InMemory) path**

Run: `pnpm test worker`
Expected: existing worker tests PASS (they pass no `waker` → inline timeout path, unchanged).

- [ ] **Step 7: Document in OPERATIONS.md**

Add a subsection under the Phase D / backpressure area:

```markdown
### Queue-wake (LISTEN/NOTIFY)

`BACKTESTER_QUEUE_NOTIFY=true` (default false; **Postgres only** — no effect on the in-memory store)
makes each worker hold one dedicated `LISTEN backtest_job_queued` connection and wake the instant a
job is enqueued (submit) or requeued (reap), instead of waiting out `WORKER_POLL_MS`. Latency-only:
polling remains the backstop, so a dropped/late notification just costs up to one poll interval —
never a stuck job. Cost: **+1 Postgres connection per worker process**, outside `BACKTESTER_PG_POOL_MAX`
(fleet math: `worker_pods × (pool_max + 1)` + API pods). Kill-switch: set the flag false.
```

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/worker-main.ts apps/backtester/src/app.ts apps/backtester/test/queue-notify-wake-pg.test.ts docs/OPERATIONS.md
git commit -m "feat(queue-notify): wire QueueWaker into the worker loop (Pg-gated wake) + OPERATIONS"
```

---

## Part B — Bundle-by-ref

### Task B1: `bundleRef` type + fingerprint fold + invariance golden

**Files:**
- Modify: `packages/sdk/src/contracts/run.ts` (`RunSubmitRequest.bundleRef`)
- Modify: `apps/backtester/src/jobs/fingerprint.ts` (`requestFingerprint` bundle-source fold)
- Test: `apps/backtester/test/fingerprint-bundle-ref.test.ts`

**Interfaces:**
- Produces: `RunSubmitRequest.bundleRef?: ContentHash`; `requestFingerprint` resolves the bundle hash from `moduleBundle` (hash the bytes) OR `bundleRef` (use directly); a shared `makeBundle()` in `test/helpers.ts`.

- [ ] **Step 1: Add a shared `makeBundle()` to `test/helpers.ts`**

The `ModuleBundle` factory currently lives as a local in `s3-store.test.ts:53`. Export a shared copy from `test/helpers.ts` for reuse across B1–B5:

```ts
// test/helpers.ts — add
import { createModuleManifest } from '<same import s3-store.test.ts uses>';
import type { ModuleBundle } from '@trading/research-contracts';

export function makeBundle(): ModuleBundle {
  const manifest = createModuleManifest({
    id: 'b', version: '1.0.0', kind: 'strategy', name: 'fixture', summary: 's', rationale: 'r',
    hooks: ['onBarClose'], paramsSchema: { type: 'object' }, capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
  });
  return { manifest, entry: 'module.mjs', files: { 'module.mjs': 'export function signals(c){return c.map(()=>false);}' } };
}
```

> Implementer note: copy the exact `createModuleManifest` import path from `s3-store.test.ts`; then refactor `s3-store.test.ts` to import `makeBundle` from `helpers.ts` (drop its local copy — DRY).

- [ ] **Step 2: Write the failing golden test**

```ts
// apps/backtester/test/fingerprint-bundle-ref.test.ts
import { describe, expect, it } from 'vitest';
import { requestFingerprint } from '../src/jobs/fingerprint.js';
import { bundleHash } from '../src/sandbox/bundle.js';
import { makeBundle } from './helpers.js';

describe('fingerprint is bundle-source-invariant', () => {
  it('inline moduleBundle and bundleRef(hash) produce the same fingerprint', () => {
    const bundle = makeBundle();
    const base = { datasetRef: 'X:1m', moduleRef: { id: 'm', version: '1' }, symbols: ['X'], timeframe: '1m',
      period: { from: '2026-01-01', to: '2026-01-02' }, seed: 1, mode: 'research', metrics: ['pnl'] } as const;
    const inline = requestFingerprint({ ...base, moduleBundle: bundle } as never);
    const byRef = requestFingerprint({ ...base, bundleRef: bundleHash(bundle) } as never);
    expect(byRef).toBe(inline);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test fingerprint-bundle-ref`
Expected: FAIL (`byRef` computed with `null` bundle ⇒ ≠ `inline`).

- [ ] **Step 4: Add `bundleRef` to the SDK contract**

In `packages/sdk/src/contracts/run.ts`, add to `RunSubmitRequest`:

```ts
  /** Content hash of a bundle already uploaded via POST /v1/bundles. Mutually exclusive with moduleBundle. */
  readonly bundleRef?: ContentHash;
```

Ensure `ContentHash` is imported in that file (it is re-exported from the SDK artifacts module).

- [ ] **Step 5: Fold the bundle source in `requestFingerprint`**

In `apps/backtester/src/jobs/fingerprint.ts`, change the `requestFingerprint` body:

```ts
export function requestFingerprint(req: RunSubmitRequest): string {
  const bundleHashValue = req.moduleBundle ? bundleHash(req.moduleBundle) : (req.bundleRef ?? null);
  return sha256Hex(canonicalJson(normalize(req, bundleHashValue)));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test fingerprint-bundle-ref`
Expected: PASS. Also run `pnpm test fingerprint` and `... test s3-store` — existing fingerprint tests still PASS (inline path unchanged when `bundleRef` absent) and s3-store still passes after switching to the shared `makeBundle`.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/contracts/run.ts apps/backtester/src/jobs/fingerprint.ts apps/backtester/src/jobs apps/backtester/test/helpers.ts apps/backtester/test/fingerprint-bundle-ref.test.ts apps/backtester/test/s3-store.test.ts
git commit -m "feat(bundle-ref): RunSubmitRequest.bundleRef + bundle-source-invariant fingerprint + shared makeBundle"
```

---

### Task B2: `submitRun` accepts `bundleRef`

**Files:**
- Modify: `apps/backtester/src/jobs/submit.ts` (`submitRun` bundle-source handling)
- Test: `apps/backtester/test/submit-bundle-ref.test.ts`

**Interfaces:**
- Consumes: `RunSubmitRequest.bundleRef` (B1), `SubmitError` (existing), `BundleStore.has` (existing).
- Produces: `submitRun` resolves `bundleHash` from `moduleBundle` (put) OR `bundleRef` (has→use); rejects both-set (400) and unknown ref (409 `unknown_bundle`); strips both bundle fields from the stored request.

**Context:** `SubmitError(statusCode, code, message, opts?)` — default `category: 'validation_error'`. `ContentHash` is `sha256:<64 hex>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backtester/test/submit-bundle-ref.test.ts
// SubmitDeps built like submit-validate.test.ts::minimalDeps, plus an InMemoryBundleStore.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { submitRun, type SubmitDeps } from '../src/jobs/submit.js';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store.js';
import { bundleHash } from '../src/sandbox/bundle.js';
import { makeBundle, runBody } from './helpers.js';

function deps(): SubmitDeps {
  return {
    store: new InMemoryJobStore(), bundleStore: new InMemoryBundleStore(),
    clock: () => 1_000_000, uid: () => randomUUID(),
    defaultQueueTimeoutMs: 60_000, defaultRunTimeoutMs: 300_000, enableOverlayEngine: true,
  };
}

describe('submitRun bundleRef', () => {
  it('rejects both moduleBundle and bundleRef (400)', async () => {
    const b = makeBundle();
    await expect(submitRun(deps(), runBody({ moduleBundle: b, bundleRef: bundleHash(b) }) as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });
  it('rejects a malformed bundleRef (400)', async () => {
    await expect(submitRun(deps(), runBody({ moduleBundle: undefined, bundleRef: 'not-a-hash' }) as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });
  it('rejects an unknown bundleRef (409 unknown_bundle)', async () => {
    await expect(submitRun(deps(), runBody({ moduleBundle: undefined, bundleRef: bundleHash(makeBundle()) }) as never))
      .rejects.toMatchObject({ statusCode: 409, code: 'unknown_bundle' });
  });
  it('accepts a known bundleRef without re-uploading', async () => {
    const d = deps();
    const hash = await d.bundleStore!.put(makeBundle());
    const out = await submitRun(d, runBody({ moduleBundle: undefined, bundleRef: hash }) as never);
    expect(out.created).toBe(true);
    const job = await d.store.get(out.handle.runId);
    expect(job?.bundleHash).toBe(hash);
    expect((job?.request as { bundleRef?: string }).bundleRef).toBeUndefined(); // stripped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test submit-bundle-ref`
Expected: FAIL (`bundleRef` unhandled).

- [ ] **Step 3: Add a ContentHash guard + bundle-source resolution in `submitRun`**

At the top of `submit.ts` add:

```ts
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
```

Replace the current bundle block (`let storedBundleHash …; if (body.moduleBundle) { … put … }`) with:

```ts
  if (body.moduleBundle && body.bundleRef) {
    throw new SubmitError(400, 'validation_error', 'provide either moduleBundle or bundleRef, not both');
  }
  let storedBundleHash: ContentHash | undefined;
  if (body.bundleRef) {
    if (!CONTENT_HASH_RE.test(body.bundleRef)) {
      throw new SubmitError(400, 'validation_error', `malformed bundleRef: ${body.bundleRef}`);
    }
    if (!deps.bundleStore) {
      throw new SubmitError(400, 'validation_error', 'module bundle submission is not enabled');
    }
    if (!(await deps.bundleStore.has(body.bundleRef))) {
      throw new SubmitError(409, 'unknown_bundle', `unknown bundle: ${body.bundleRef}`);
    }
    storedBundleHash = body.bundleRef;
  } else if (body.moduleBundle) {
    if (!deps.bundleStore) {
      throw new SubmitError(400, 'validation_error', 'module bundle submission is not enabled');
    }
    storedBundleHash = await deps.bundleStore.put(body.moduleBundle);
  }
```

Then strip BOTH bundle fields from the stored request — change the destructure:

```ts
  const { moduleBundle: _omitBundle, bundleRef: _omitRef, ...rest } = body;
```

(The `resumeToken` replay pre-lookup above this block is unchanged — a by-ref replay recomputes the same fingerprint via B1, so `assertReplayFingerprint` still matches.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test submit-bundle-ref`
Expected: PASS (4 tests).

- [ ] **Step 5: Regression — existing submit tests green**

Run: `pnpm test submit`
Expected: PASS (inline moduleBundle path unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/submit.ts apps/backtester/test/submit-bundle-ref.test.ts
git commit -m "feat(bundle-ref): submitRun accepts bundleRef (XOR guard, has->409, strip from stored request)"
```

---

### Task B3: `POST /v1/bundles` + `HEAD /v1/bundles/:hash`

**Files:**
- Create: `apps/backtester/src/api/bundles.ts`
- Modify: `apps/backtester/src/api/server.ts` (mount the routes)
- Test: `apps/backtester/test/bundles-api.test.ts`

**Interfaces:**
- Consumes: `ServerDeps.bundleStore` (already on `SubmitDeps`, which `ServerDeps` extends), the `validateBundle` used by `/v1/modules/validate`, `bundleStore.put`/`has`.
- Produces: `function registerBundleRoutes(app: FastifyInstance, deps: ServerDeps): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backtester/test/bundles-api.test.ts
// Real app over the in-memory factory; drive the routes through the app's Fastify server (app.server).
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH, makeApp, makeBundle } from './helpers.js';
import { STORE_FACTORIES } from './store-factories.js';
import { bundleHash } from '../src/sandbox/bundle.js';

const memFactory = STORE_FACTORIES.find((f) => f.name === 'in-memory')!;
let teardown: (() => Promise<void>) | undefined;
afterEach(async () => { await teardown?.(); teardown = undefined; });

async function server() {
  const { app, cleanup } = await makeApp(memFactory);
  teardown = cleanup;
  return app.server; // FastifyInstance (AppHandles.server)
}

describe('bundles API', () => {
  it('POST /v1/bundles stores a valid bundle (hash matches) and HEAD confirms it', async () => {
    const s = await server();
    const b = makeBundle();
    const res = await s.inject({ method: 'POST', url: '/v1/bundles', headers: AUTH, payload: b });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(bundleHash(b));
    expect((await s.inject({ method: 'HEAD', url: `/v1/bundles/${bundleHash(b)}`, headers: AUTH })).statusCode).toBe(200);
  });
  it('POST /v1/bundles rejects an invalid bundle (400)', async () => {
    const s = await server();
    const res = await s.inject({ method: 'POST', url: '/v1/bundles', headers: AUTH, payload: { not: 'a bundle' } });
    expect(res.statusCode).toBe(400);
  });
  it('HEAD /v1/bundles/:hash — 404 absent, 400 malformed', async () => {
    const s = await server();
    expect((await s.inject({ method: 'HEAD', url: `/v1/bundles/sha256:${'0'.repeat(64)}`, headers: AUTH })).statusCode).toBe(404);
    expect((await s.inject({ method: 'HEAD', url: '/v1/bundles/nope', headers: AUTH })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test bundles-api`
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement the routes module**

```ts
// apps/backtester/src/api/bundles.ts
import type { FastifyInstance } from 'fastify';
import type { ModuleBundle } from '@trading/research-contracts';
import type { ServerDeps } from './server.js';
// The SAME one-arg structural validator /v1/modules/validate calls on body.moduleBundle.
// Signature: validateBundle(input: unknown): BundleIssue[]  where BundleIssue = { code: string; message: string }.
import { validateBundle } from '../sandbox/bundle.js';

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function registerBundleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post('/v1/bundles', async (req, reply) => {
    if (!deps.bundleStore) {
      return reply.code(400).send({ category: 'validation_error', code: 'validation_error', message: 'bundle store not enabled' });
    }
    const issues = validateBundle(req.body); // structural; takes `unknown`, so a garbage body is safe
    if (issues.length > 0) {
      return reply.code(400).send({ category: 'validation_error', code: 'bundle_invalid', message: issues[0].message, issues });
    }
    const hash = await deps.bundleStore.put(req.body as ModuleBundle);
    return reply.code(200).send({ hash });
  });

  app.head('/v1/bundles/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!CONTENT_HASH_RE.test(hash)) return reply.code(400).send();
    if (!deps.bundleStore) return reply.code(404).send();
    return reply.code((await deps.bundleStore.has(hash)) ? 200 : 404).send();
  });
}
```

> Implementer note: use `validateBundle` from `apps/backtester/src/sandbox/bundle.ts` (the one-arg structural `validateBundle(input: unknown): BundleIssue[]` that `/v1/modules/validate` already uses — it needs no contract context). Do NOT use the two-arg `acceptance-gate` `validateBundle` (it requires a materialized `bundleDir`).

- [ ] **Step 4: Mount in `server.ts`**

Add `import { registerBundleRoutes } from './bundles.js';` and, inside `buildServer` before `return app;`:

```ts
  registerBundleRoutes(app, deps);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test bundles-api`
Expected: PASS (3 tests). The `/v1/*` auth hook already protects these routes — add a no-auth 401 assertion if the suite has an auth helper.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/api/bundles.ts apps/backtester/src/api/server.ts apps/backtester/test/bundles-api.test.ts
git commit -m "feat(bundle-ref): POST /v1/bundles + HEAD /v1/bundles/:hash"
```

---

### Task B4: SDK client — `putBundle`, `hasBundle`, by-ref submit + self-healing

**Files:**
- Modify: `packages/sdk/src/client/client.ts` (`putBundle`, `hasBundle`, submit self-healing)
- Modify: `packages/sdk/package.json`, `packages/sdk/src/internal/versions.ts`, and the two version tests (version bump)
- Test: `packages/sdk/test/bundle-ref-client.test.ts`

**Interfaces:**
- Consumes: `RunSubmitRequest.bundleRef` (B1), `POST /v1/bundles`/`HEAD` (B3), 409 `unknown_bundle` (B2).
- Produces: `BacktesterClient.putBundle(bundle): Promise<ContentHash>`, `BacktesterClient.hasBundle(hash): Promise<boolean>`. `submitRun` self-heals a 409 `unknown_bundle` with ONE re-PUT+retry **only when it holds the bundle bytes**, reusing the same `resumeToken`.

- [ ] **Step 1: Write the failing tests (against a mock fetch)**

```ts
// packages/sdk/test/bundle-ref-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BacktesterClient } from '../src/client/client.js';

function mockFetch(handlers: Record<string, (init: RequestInit) => Response>) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    const h = handlers[key];
    if (!h) return new Response('not found', { status: 404 });
    return h(init);
  });
}

describe('SDK bundle-ref', () => {
  it('putBundle POSTs and returns the hash', async () => {
    const fetch = mockFetch({ 'POST /v1/bundles': () => new Response(JSON.stringify({ hash: 'sha256:' + 'a'.repeat(64) }), { status: 200 }) });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetch: fetch as never });
    expect(await c.putBundle({} as never)).toBe('sha256:' + 'a'.repeat(64));
  });

  it('submitRun with moduleBundle self-heals ONE 409 unknown_bundle via re-PUT + retry with the same resumeToken', async () => {
    let submitCalls = 0; let putCalls = 0; const tokens: unknown[] = [];
    const H = 'sha256:' + 'b'.repeat(64);
    const fetch = mockFetch({
      'POST /v1/bundles': () => { putCalls++; return new Response(JSON.stringify({ hash: H }), { status: 200 }); },
      'POST /v1/runs': (init) => {
        submitCalls++;
        tokens.push(JSON.parse(String(init.body)).resumeToken);
        return submitCalls === 1
          ? new Response(JSON.stringify({ category: 'validation_error', code: 'unknown_bundle', message: 'x' }), { status: 409 })
          : new Response(JSON.stringify({ runId: 'r', status: 'accepted' }), { status: 202 });
      },
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetch: fetch as never });
    await c.submitRun({ resumeToken: 'tok', bundleRef: H, moduleBundle: {} as never } as never);
    expect(putCalls).toBe(1);
    expect(submitCalls).toBe(2);
    expect(tokens).toEqual(['tok', 'tok']); // same resumeToken on retry
  });

  it('submitRun with ONLY bundleRef surfaces 409 (no bytes to re-PUT)', async () => {
    const fetch = mockFetch({
      'POST /v1/runs': () => new Response(JSON.stringify({ code: 'unknown_bundle', message: 'x' }), { status: 409 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetch: fetch as never });
    await expect(c.submitRun({ resumeToken: 'tok', bundleRef: 'sha256:' + 'c'.repeat(64) } as never)).rejects.toBeTruthy();
  });
});
```

> Implementer note: match the client's real `fetch` injection point + request shape (`request()` at `client.ts:111`). Adjust the mock signature to the client's actual fetch contract; the assertions (put count, submit count, resumeToken identity, surface-when-no-bytes) are the spec.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-backtester/sdk test bundle-ref-client`
Expected: FAIL (`putBundle`/self-heal absent).

- [ ] **Step 3: Add `putBundle` / `hasBundle` + self-healing submit**

In `client.ts`:

```ts
  async putBundle(bundle: ModuleBundle): Promise<ContentHash> {
    const { hash } = await this.request<{ hash: ContentHash }>('POST', '/v1/bundles', bundle);
    return hash;
  }

  async hasBundle(hash: ContentHash): Promise<boolean> {
    try { await this.request('HEAD', `/v1/bundles/${hash}`); return true; }
    catch (e) { if (isStatus(e, 404)) return false; throw e; }
  }
```

In `submitRun`, wrap the POST so a 409 `unknown_bundle` re-PUTs and retries once **only if `req.moduleBundle` is present** (bytes in hand), keeping the same request object (hence the same `resumeToken`):

```ts
  async submitRun(req: RunSubmitRequest): Promise<RunJobHandle> {
    try {
      return await this.request<RunJobHandle>('POST', '/v1/runs', req);
    } catch (e) {
      if (isStatus(e, 409) && codeOf(e) === 'unknown_bundle' && req.moduleBundle) {
        await this.putBundle(req.moduleBundle);
        return await this.request<RunJobHandle>('POST', '/v1/runs', req); // same req ⇒ same resumeToken
      }
      throw e;
    }
  }
```

Add small helpers `isStatus(err, n)` / `codeOf(err)` reading the client's thrown error shape (see `errors.ts`). Do NOT let `submitRun`'s inner `request` auto-retry the 409 into a duplicate — the safe-retry layer already treats 409 as terminal; this is a bounded, explicit single re-PUT+retry.

- [ ] **Step 4: Bump the SDK version (4 sites)**

Bump `packages/sdk/package.json` `version`, `packages/sdk/src/internal/versions.ts` `SDK_VERSION`, and update the expected values in `packages/sdk/test/package-shape.test.ts` and the SDK `registry-contract.test`. Use the next minor (e.g. `0.8.0`). Confirm no Node globals leaked into public `.d.ts` (`ModuleBundle`/`ContentHash` are already public SDK types).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @trading-backtester/sdk test`
Expected: PASS (new bundle-ref tests + version tests updated).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/client/client.ts packages/sdk/package.json packages/sdk/src/internal/versions.ts packages/sdk/test/
git commit -m "feat(sdk): putBundle/hasBundle + submit self-healing on unknown_bundle; bump SDK version"
```

---

### Task B5: End-to-end dedup HIT (inline → by-ref) + bundle-by-ref OPERATIONS

**Files:**
- Test: `apps/backtester/test/bundle-ref-dedup-pg.test.ts`
- Modify: `docs/OPERATIONS.md` (bundle-by-ref section)

**Interfaces:**
- Consumes: everything in Part B + the existing dedup worker path.

**Note on gating:** the FIRST (inline) submit must actually compute → a bundle strategy runs in the
Docker sandbox, so this full e2e is **Docker + Pg gated** (`skipIf(!PG_AVAILABLE || !DOCKER_AVAILABLE)`)
and runs in CI, not WSL2. B1's fingerprint-invariance golden is the fast, always-run load-bearing gate
(equal fingerprint ⇒ equal `computeIdentity` ⇒ the HIT is guaranteed by construction); B5 is the
full-path confirmation.

- [ ] **Step 1: Write the Docker+Pg-gated e2e test**

```ts
// apps/backtester/test/bundle-ref-dedup-pg.test.ts
// Inline submit of bundle X, then a by-ref submit of hash(X): the second is a dedup HIT that skips
// the engine and re-stamps for its own runId. Do NOT assert equal result_hash across the two runs.
import { describe, expect, it } from 'vitest';
import { PG_AVAILABLE, DOCKER_AVAILABLE, STORE_FACTORIES } from './store-factories.js';
import { AUTH, makeApp, makeBundle } from './helpers.js';
import { bundleHash } from '../src/sandbox/bundle.js';

const pgFactory = STORE_FACTORIES.find((f) => f.name === 'postgres')!;

describe.skipIf(!PG_AVAILABLE || !DOCKER_AVAILABLE)('bundle-ref dedup HIT', () => {
  it('by-ref of an already-computed inline bundle is a dedup HIT (no engine, re-stamped runId)', async () => {
    const { app, store, cleanup } = await makeApp(pgFactory, {}, { dedupEnabled: true });
    const b = makeBundle();
    const post = (payload: unknown) => app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });

    const a = (await post({ ...bundleReq(), moduleBundle: b })).json();   // inline
    await app.drain();                                                     // compute + populate cache
    const ref = bundleHash(b);
    const c = (await post({ ...bundleReq(), bundleRef: ref })).json();     // by-ref, same identity
    await app.drain();                                                     // HIT path (no engine)

    const jobC = await store.get(c.runId);
    const jobA = await store.get(a.runId);
    expect(jobC?.dedupedFrom).toBe(a.runId);              // HIT, sourced from the inline run
    expect(jobC?.resultSummary).toBeTruthy();             // re-stamped payload present
    expect(jobC?.resultHash).not.toBe(jobA?.resultHash);  // runId-stamped ⇒ MUST differ (not equal-hash)
    await cleanup();
  });
});

// A valid strategy-bundle run request body (mirror runBody, but for the bundle/sandbox path). Reuse
// the exact request shape a passing sandbox test uses (e.g. worker-loop.test.ts / sandbox.test.ts).
function bundleReq() {
  return { engine: 'strategy', datasetRef: 'BEATUSDT:1m', moduleRef: { id: 'b', version: '1.0.0' },
    symbols: ['BEATUSDT'], timeframe: '1m', period: { from: '…', to: '…' }, seed: 1, mode: 'research',
    metrics: ['pnl'] };
}
```

> Implementer note: fill `bundleReq()` from the exact request + dataset a passing sandbox test already
> uses (`worker-loop.test.ts` / `sandbox.test.ts` run real bundles) so the inline run actually completes
> under the test data port. The point is the HIT bookkeeping on the by-ref run, not new strategy logic.

- [ ] **Step 2: Run test to verify it fails or passes**

With `DATABASE_URL` exported AND Docker available: `pnpm test bundle-ref-dedup-pg`
Expected: PASS if B1–B2 already make it work (fingerprint invariance ⇒ same `computeIdentity` ⇒ HIT). If it FAILS, the failure localizes a fingerprint/identity gap — fix in `fingerprint.ts`/`submit.ts`. Skips cleanly (not fails) when Postgres or Docker is unreachable — so it will skip on WSL2 and must be green in CI's Docker+Pg lane.

- [ ] **Step 3: Document bundle-by-ref in OPERATIONS.md**

```markdown
### Bundle-by-ref

`POST /v1/bundles` (body = a ModuleBundle) validates the bundle and stores it in the content-addressed
`BundleStore`, returning `{ hash }`. `HEAD /v1/bundles/:hash` reports presence. `POST /v1/runs` accepts
`bundleRef` (a `sha256:…` content hash) as an alternative to inline `moduleBundle` — exactly one of the
two. A run submitted by-ref that references an unknown hash gets `409 unknown_bundle`; the SDK self-heals
by re-uploading once and retrying with the same `resumeToken`. Fingerprint/dedup identity is
submission-style-invariant (inline X and bundleRef=hash(X) share one identity), so a by-ref submit of an
already-computed bundle is a dedup HIT.

**Multi-node:** `FileBundleStore` is host-local — a bundle uploaded to one node is invisible to another.
Cross-fleet bundle-by-ref requires the shared `S3BundleStore` (`BACKTESTER_STORE_BACKEND=s3`). On a single
node it works as-is; the `409 → re-PUT` self-heal covers a ref that misses on the wrong node (one extra
upload, never a failure). No bundle GC/TTL yet — deferred to the multi-user gate.
```

- [ ] **Step 4: Full suite + typecheck**

With `DATABASE_URL` exported: `pnpm -r check && pnpm test && pnpm --filter @trading-backtester/sdk test`
Expected: green (Pg-gated tests run against the DB; Docker-gated B5 skips on WSL2).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/bundle-ref-dedup-pg.test.ts docs/OPERATIONS.md
git commit -m "test(bundle-ref): e2e dedup HIT inline->by-ref (restamp, not equal-hash) + OPERATIONS"
```

---

## Notes for the executor

- **Pg-gated tests** are mandatory and must actually run against Postgres before the PR is called done — start the stand's `backtester-pg` (`deploy/vps` docs) or a local Postgres and export `DATABASE_URL` (or `BACKTESTER_TEST_DATABASE_URL`); the harness probes it once into `PG_AVAILABLE`. A green run where every Pg test *skipped* is NOT sufficient for A2/A3/A4. B5 additionally needs Docker (CI lane); on WSL2 it skips.
- **Behavior-preservation:** after Part A, the flag-off / InMemory worker path must be byte-for-byte unchanged (existing worker + coalesce + dedup suites green). After Part B, the inline-`moduleBundle` submit path must be unchanged (existing submit + fingerprint suites green).
- **One PR** covering both parts; the final whole-branch review runs on the most capable model.
