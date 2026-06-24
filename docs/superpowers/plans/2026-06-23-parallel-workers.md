# Parallel Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the job queue with bounded in-process async concurrency (up to `N` backtests at once in the single worker process), so I/O-bound sandboxed sweeps run in parallel instead of serially — while preserving the shared in-process tape cache.

**Architecture:** A generic `runBoundedPool(concurrency, next)` helper runs up to `N` concurrent `processNextQueued` executions. `drainQueue(deps, concurrency)` uses it; the worker passes a new `WORKER_CONCURRENCY` config value. Concurrency safety rests on the existing atomic claim (`SKIP LOCKED` in Postgres; synchronous compare-and-set in the in-memory store) plus two small hardening fixes (atomic artifact write, unique sandbox-harness temp dir). Parallel execution is result-identical to serial.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, Vitest 2.

## Global Constraints

- ESM with explicit `.js` import extensions on relative imports.
- No new runtime dependencies.
- The frozen momentum golden result_hash MUST NOT move: `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba`. Overlay goldens must not move. `WORKER_CONCURRENCY=1` must reproduce the current strictly-serial behavior exactly.
- Parallel execution MUST be result-identical to serial: same set of jobs → same set of result hashes regardless of concurrency.
- Config: env `WORKER_CONCURRENCY`, default `4`, clamped to `>= 1`. Test config (`testConfig`) defaults to `1` so existing single-job tests keep exact serial behavior.
- Test runner: Vitest. Fast single-file run: `npx vitest run apps/backtester/test/<file>.test.ts`. Full gate: `pnpm test`.

## Deviation from spec (decided during plan grounding)

The spec's §3 prescribes an in-process async mutex around `InMemoryJobStore.claimNextQueued`. Grounding the code shows it is **unnecessary**: `transition` (`jobs/job-store.ts:148-162`) is a fully synchronous compare-and-set (`if (job.status !== from) return false; job.status = to;`) with no `await` between the status check and the write. In a single-threaded event loop this is an atomic CAS — two concurrent claimers can never both win `queued → running`, and the pool's startup burst issues claims synchronously in sequence (each claim's CAS lands before the next claim's filter runs). Adding a mutex would guard a hazard that cannot occur. **This plan replaces the mutex with a concurrency-safety regression test (Task 3)** that pins the invariant (and would catch a future regression that made `transition` truly async). Postgres is already safe via `FOR UPDATE SKIP LOCKED` and is untouched.

---

## File Structure

- **Create** `apps/backtester/src/jobs/pool.ts` — `runBoundedPool`. One responsibility: bounded-concurrency drain loop.
- **Create** `apps/backtester/test/pool.test.ts` — unit tests for the pool.
- **Modify** `apps/backtester/src/jobs/worker.ts` — `drainQueue(deps, concurrency)` uses the pool.
- **Modify** `apps/backtester/src/config.ts` — add `workerConcurrency` to `AppConfig` + parse `WORKER_CONCURRENCY`.
- **Modify** `apps/backtester/src/app.ts` — `drain` passes `config.workerConcurrency`.
- **Modify** `apps/backtester/test/helpers.ts` — `testConfig` provides `workerConcurrency: 1`.
- **Create** `apps/backtester/test/worker-concurrency.test.ts` — config parse + the end-to-end determinism test (concurrent drain == serial drain).
- **Create** `apps/backtester/test/claim-concurrency.test.ts` — concurrent-claim safety regression.
- **Modify** `apps/backtester/src/artifacts/store.ts` — atomic `write` (temp + rename).
- **Create** `apps/backtester/test/artifact-store-concurrency.test.ts` — concurrent same-payload write.
- **Modify** `apps/backtester/src/engine/sandbox/harness-volume.ts` — unique temp-dir suffix.
- **Create** `apps/backtester/test/harness-volume.test.ts` — behavioral pin for `ensureHarnessInVolume`.

---

### Task 1: Bounded-concurrency pool helper

**Files:**
- Create: `apps/backtester/src/jobs/pool.ts`
- Test: `apps/backtester/test/pool.test.ts`

**Interfaces:**
- Produces: `runBoundedPool(concurrency: number, next: () => Promise<boolean>): Promise<number>` — runs up to `concurrency` concurrent `next()` loops until `next()` returns false; returns the count of truthy results; clamps `concurrency` to `>= 1`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backtester/test/pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBoundedPool } from '../src/jobs/pool.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runBoundedPool', () => {
  it('keeps at most `concurrency` next() calls in flight', async () => {
    const concurrency = 3;
    const total = 8;
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const next = (): Promise<boolean> => {
      if (started >= total) return Promise.resolve(false);
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<boolean>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve(true);
        });
      });
    };
    const done = runBoundedPool(concurrency, next);
    await tick(); // let the pool fill its slots
    expect(inFlight).toBe(concurrency); // exactly `concurrency` active, never more
    while (releases.length > 0) {
      releases.shift()!();
      await tick(); // the freed slot loops and calls next() again
    }
    const processed = await done;
    expect(peak).toBe(concurrency);
    expect(processed).toBe(total);
  });

  it('processes every item exactly once', async () => {
    let remaining = 5;
    let calls = 0;
    const next = async (): Promise<boolean> => {
      calls += 1;
      if (remaining === 0) return false;
      remaining -= 1;
      return true;
    };
    const processed = await runBoundedPool(2, next);
    expect(processed).toBe(5);
    expect(calls).toBeGreaterThanOrEqual(6); // 5 truthy + at least one trailing false
  });

  it('clamps concurrency below 1 up to 1', async () => {
    let remaining = 3;
    const next = async (): Promise<boolean> => remaining-- > 0;
    const processed = await runBoundedPool(0, next);
    expect(processed).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backtester/test/pool.test.ts`
Expected: FAIL — cannot resolve `'../src/jobs/pool.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/backtester/src/jobs/pool.ts`:

```ts
/**
 * Run `next` across up to `concurrency` concurrent slots until it returns false (queue drained).
 * Each slot loops independently; a slot exits when its `next()` resolves false. Returns the total
 * number of truthy `next()` results. `concurrency` is clamped to `>= 1`.
 */
export async function runBoundedPool(
  concurrency: number,
  next: () => Promise<boolean>,
): Promise<number> {
  const slots = Math.max(1, Math.floor(concurrency));
  let processed = 0;
  const worker = async (): Promise<void> => {
    while (await next()) processed += 1;
  };
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return processed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backtester/test/pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/pool.ts apps/backtester/test/pool.test.ts
git commit -m "feat(jobs): runBoundedPool — bounded-concurrency drain helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: WORKER_CONCURRENCY config + wire drainQueue through the pool

**Files:**
- Modify: `apps/backtester/src/config.ts` (add `workerConcurrency` to `AppConfig` ~line 76; parse in `loadConfig` ~line 137)
- Modify: `apps/backtester/src/jobs/worker.ts` (`drainQueue` at line 301)
- Modify: `apps/backtester/src/app.ts` (`drain` at line 110)
- Modify: `apps/backtester/test/helpers.ts` (`testConfig` ~line 31)
- Test: `apps/backtester/test/worker-concurrency.test.ts` (config-parse portion)

**Interfaces:**
- Consumes: `runBoundedPool` (Task 1).
- Produces: `AppConfig.workerConcurrency: number`; `drainQueue(deps: WorkerDeps, concurrency?: number): Promise<number>` (default `1`).

- [ ] **Step 1: Write the failing config test**

Create `apps/backtester/test/worker-concurrency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('WORKER_CONCURRENCY config', () => {
  it('defaults to 4 when unset', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: undefined });
    expect(cfg.workerConcurrency).toBe(4);
  });
  it('parses an explicit value', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: '8' });
    expect(cfg.workerConcurrency).toBe(8);
  });
  it('clamps values below 1 up to 1', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: '0' });
    expect(cfg.workerConcurrency).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/worker-concurrency.test.ts`
Expected: FAIL — `cfg.workerConcurrency` is `undefined` / not on the type.

- [ ] **Step 3: Add the config field**

In `apps/backtester/src/config.ts`, add to the `AppConfig` interface (after `autoWorker`, ~line 76):

```ts
  /** Max backtests run concurrently by the in-process worker pool (>= 1; 1 = serial). */
  readonly workerConcurrency: number;
```

In `loadConfig`'s returned object (after the `autoWorker` line, ~line 137):

```ts
    workerConcurrency: Math.max(1, Number(env.WORKER_CONCURRENCY ?? 4)),
```

- [ ] **Step 4: Wire drainQueue through the pool**

In `apps/backtester/src/jobs/worker.ts`, add the import alongside the other relative imports:

```ts
import { runBoundedPool } from './pool.js';
```

Replace `drainQueue` (lines 300-305):

```ts
/** Drain every currently-queued job. Returns the number processed. */
export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  while ((await processNextQueued(deps)) !== undefined) processed += 1;
  return processed;
}
```

with:

```ts
/** Drain queued jobs with up to `concurrency` runs in flight (default 1 = serial). Returns count processed. */
export async function drainQueue(deps: WorkerDeps, concurrency = 1): Promise<number> {
  return runBoundedPool(concurrency, async () => (await processNextQueued(deps)) !== undefined);
}
```

- [ ] **Step 5: Wire the worker to the config**

In `apps/backtester/src/app.ts`, change `drain` (line 110):

```ts
  const drain = (): Promise<number> => drainQueue(workerDeps);
```

to:

```ts
  const drain = (): Promise<number> => drainQueue(workerDeps, config.workerConcurrency);
```

- [ ] **Step 6: Give testConfig a serial default**

In `apps/backtester/test/helpers.ts`, add to the object returned by `testConfig` (after `autoWorker: false,`, ~line 31):

```ts
    workerConcurrency: 1,
```

- [ ] **Step 7: Typecheck (catches any other AppConfig literal)**

Run: `pnpm typecheck`
Expected: PASS. If it flags another object literal missing `workerConcurrency`, add `workerConcurrency: 1` there.

- [ ] **Step 8: Run config test + a serial-regression sweep**

Run: `npx vitest run apps/backtester/test/worker-concurrency.test.ts apps/backtester/test/momentum-guardrail.test.ts apps/backtester/test/completion.test.ts apps/backtester/test/api.e2e.test.ts`
Expected: PASS — config parses; existing `app.drain()` tests still pass (testConfig concurrency = 1 preserves serial behavior).

- [ ] **Step 9: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/src/jobs/worker.ts apps/backtester/src/app.ts apps/backtester/test/helpers.ts apps/backtester/test/worker-concurrency.test.ts
git commit -m "feat(worker): WORKER_CONCURRENCY — drain queue via bounded pool

drainQueue(deps, concurrency=1) now runs up to N processNextQueued in flight;
the worker reads config.workerConcurrency (default 4). testConfig stays serial (1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Concurrent-claim safety regression

**Files:**
- Test: `apps/backtester/test/claim-concurrency.test.ts`

**Interfaces:**
- Consumes: `buildTestApp`, `runBody`, `AUTH` from `./helpers` (the proven submission path); `app.store.claimNextQueued`.

This task adds NO production code (per the spec deviation above): it pins that concurrent claims on the in-memory store hand each job to exactly one claimer.

- [ ] **Step 1: Write the test**

Create `apps/backtester/test/claim-concurrency.test.ts`:

```ts
// Pins concurrent-claim safety for the in-memory job store: when the parallel worker pool issues many
// concurrent claimNextQueued calls, each queued job is claimed by exactly one caller — no double-claim,
// no spurious giveaway. (Postgres handles this via FOR UPDATE SKIP LOCKED; this guards the in-memory CAS.)

import { describe, expect, it, afterEach } from 'vitest';
import { buildTestApp, runBody, AUTH } from './helpers.js';
import type { AppHandles } from '../src/app.js';

let app: AppHandles | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

describe('concurrent claimNextQueued (in-memory store)', () => {
  it('claims each queued job exactly once across many concurrent claimers', async () => {
    app = await buildTestApp();
    const N = 5;
    // Distinct seeds -> distinct request fingerprints -> N distinct queued jobs (no submit-dedup).
    for (let i = 0; i < N; i += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ seed: i }),
      });
      expect(res.statusCode).toBe(202);
    }

    // Fire more claimers than jobs, concurrently.
    const claims = await Promise.all(
      Array.from({ length: N * 3 }, () => app!.store.claimNextQueued(1_700_000_000_001)),
    );
    const claimedIds = claims.filter((j) => j !== undefined).map((j) => j!.runId);

    expect(claimedIds.length).toBe(N); // exactly N jobs claimed
    expect(new Set(claimedIds).size).toBe(N); // no job claimed twice
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/backtester/test/claim-concurrency.test.ts`
Expected: PASS. (It pins an invariant the synchronous CAS already guarantees; if it ever fails, `transition` or `claimNextQueued` gained an `await` between read and write and needs serialization.)

Note: the submit status code is asserted as `202`; if the route returns a different success code, match it to the value used in `api.e2e.test.ts` (do not change the route).

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test/claim-concurrency.test.ts
git commit -m "test(jobs): pin concurrent-claim safety for in-memory store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Atomic artifact write

**Files:**
- Modify: `apps/backtester/src/artifacts/store.ts` (`FileArtifactStore.write`)
- Test: `apps/backtester/test/artifact-store-concurrency.test.ts`

**Interfaces:**
- `FileArtifactStore.write(payload: unknown): Promise<ContentHash>` — unchanged signature; now writes atomically (temp file + rename) so concurrent writers of the same content-addressed path cannot produce a torn read.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/artifact-store-concurrency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FileArtifactStore } from '../src/artifacts/store.js';

describe('FileArtifactStore concurrent writes', () => {
  it('writes the same payload concurrently and always reads back intact', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'bt-artifact-conc-'));
    const store = new FileArtifactStore(dir);
    const payload = { a: 1, nested: { values: Array.from({ length: 500 }, (_, i) => i) } };

    const refs = await Promise.all(Array.from({ length: 20 }, () => store.write(payload)));
    // Content-addressed: every concurrent write yields the same ref.
    expect(new Set(refs.map(String)).size).toBe(1);

    const readBack = await store.read(refs[0]!);
    expect(readBack).toEqual(payload); // never a truncated/torn file
  });
});
```

- [ ] **Step 2: Run to verify it passes today or reveals the hazard**

Run: `npx vitest run apps/backtester/test/artifact-store-concurrency.test.ts`
Expected: This MAY already pass (the OS often serializes small writes), but the current non-atomic `writeFile` to a shared path is not guaranteed safe under concurrency. Proceed to make the write atomic regardless.

- [ ] **Step 3: Make the write atomic**

In `apps/backtester/src/artifacts/store.ts`, update the imports from `node:fs/promises` to include `rename` (add it to the existing import list), and add `randomBytes` from `node:crypto`:

```ts
import { randomBytes } from 'node:crypto';
```

Replace `FileArtifactStore.write`:

```ts
  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.pathFor(ref), canonicalJson(payload), 'utf8');
    return ref;
  }
```

with:

```ts
  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    await mkdir(this.baseDir, { recursive: true });
    const dest = this.pathFor(ref);
    // Atomic publish: write a unique temp file then rename, so concurrent writers of the same
    // content-addressed path can never expose a truncated/torn read.
    const tmp = `${dest}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(tmp, canonicalJson(payload), 'utf8');
    await rename(tmp, dest);
    return ref;
  }
```

(Ensure `rename` is imported: the existing `import { mkdir, writeFile, readFile, access } from 'node:fs/promises';` becomes `import { mkdir, writeFile, readFile, access, rename } from 'node:fs/promises';` — match the actual existing import line.)

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run apps/backtester/test/artifact-store-concurrency.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/artifacts/store.ts apps/backtester/test/artifact-store-concurrency.test.ts
git commit -m "fix(artifacts): atomic FileArtifactStore write (temp + rename)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Unique sandbox-harness temp dir

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/harness-volume.ts` (`ensureHarnessInVolume`, line ~52)
- Test: `apps/backtester/test/harness-volume.test.ts`

**Interfaces:**
- `ensureHarnessInVolume(harnessDir: string, mountpoint: string): string` — unchanged signature; the temp dir now carries a unique suffix so two concurrent first-time materializations in the same process cannot collide on `${dest}.tmp-${pid}`.

- [ ] **Step 1: Write the failing/behavioral test**

Create `apps/backtester/test/harness-volume.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureHarnessInVolume } from '../src/engine/sandbox/harness-volume.js';

describe('ensureHarnessInVolume', () => {
  it('materializes the harness into the volume and is idempotent', () => {
    const harnessDir = mkdtempSync(resolve(tmpdir(), 'bt-harness-src-'));
    mkdirSync(join(harnessDir, 'sub'), { recursive: true });
    writeFileSync(join(harnessDir, 'entry.mjs'), 'export const x = 1;\n');
    writeFileSync(join(harnessDir, 'sub', 'f.txt'), 'hi\n');
    const mountpoint = mkdtempSync(resolve(tmpdir(), 'bt-mount-'));

    const dest1 = ensureHarnessInVolume(harnessDir, mountpoint);
    expect(existsSync(join(dest1, 'entry.mjs'))).toBe(true);
    expect(readFileSync(join(dest1, 'sub', 'f.txt'), 'utf8')).toBe('hi\n');

    // Second call: dest already exists -> idempotent no-op, same path.
    const dest2 = ensureHarnessInVolume(harnessDir, mountpoint);
    expect(dest2).toBe(dest1);
  });
});
```

- [ ] **Step 2: Run to verify it passes (pre-change baseline)**

Run: `npx vitest run apps/backtester/test/harness-volume.test.ts`
Expected: PASS (the function already works single-threaded; this pins behavior before the concurrency hardening).

- [ ] **Step 3: Make the temp suffix unique**

In `apps/backtester/src/engine/sandbox/harness-volume.ts`, ensure `randomBytes` is imported from `node:crypto` (add `import { randomBytes } from 'node:crypto';` if absent), then change the temp line inside `ensureHarnessInVolume`:

```ts
    const tmp = `${dest}.tmp-${process.pid}`;
```

to:

```ts
    // Unique per call: two concurrent first-time materializations in the same process (same pid)
    // must not share a temp dir, or their parallel copies would corrupt each other.
    const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run apps/backtester/test/harness-volume.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/harness-volume.ts apps/backtester/test/harness-volume.test.ts
git commit -m "fix(sandbox): unique harness-volume temp dir for concurrent materialization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Determinism under concurrency (end-to-end)

**Files:**
- Test: `apps/backtester/test/worker-concurrency.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `buildTestApp`, `runBody`, `AUTH` from `./helpers`; `AppHandles.drain` / `app.store`; `WORKER_CONCURRENCY` config (Task 2).

This is the load-bearing correctness test: the SAME set of jobs drained concurrently produces the SAME result hashes as drained serially. Uses the momentum trusted path (deterministic, no Docker).

- [ ] **Step 1: Write the test**

Append to `apps/backtester/test/worker-concurrency.test.ts`:

```ts
import { buildTestApp, runBody, AUTH } from './helpers.js';
import type { AppHandles } from '../src/app.js';

/** Submit N distinct-seed momentum jobs, drain, return a {seed -> resultHash} map. */
async function drainSweep(concurrency: number, n: number): Promise<Map<number, string>> {
  const app: AppHandles = await buildTestApp({ workerConcurrency: concurrency });
  try {
    const runIdToSeed = new Map<string, number>();
    for (let seed = 0; seed < n; seed += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ seed }),
      });
      expect(res.statusCode).toBe(202);
      const runId = (res.json() as { runId: string }).runId;
      runIdToSeed.set(runId, seed);
    }
    const processed = await app.drain();
    expect(processed).toBe(n); // all jobs drained

    const bySeed = new Map<number, string>();
    for (const [runId, seed] of runIdToSeed) {
      const job = await app.store.get(runId);
      expect(job?.status).toBe('completed');
      bySeed.set(seed, String(job!.resultHash));
    }
    return bySeed;
  } finally {
    await app.dispose();
  }
}

describe('determinism under concurrency', () => {
  it('parallel drain produces the same result hashes as serial drain', async () => {
    const N = 6;
    const serial = await drainSweep(1, N);
    const parallel = await drainSweep(4, N);
    expect(parallel.size).toBe(N);
    for (const [seed, hash] of serial) {
      expect(parallel.get(seed)).toBe(hash); // identical result per job, regardless of concurrency
    }
  });
});
```

Notes for the implementer:
- The submit success code (`202`) and the response field (`runId`) and the terminal status (`completed`) and the job field (`resultHash`) must match what the codebase actually uses. Confirm against `api.e2e.test.ts` / `terminal-result-api.test.ts` and the `JobRow` type; adjust the literals to match (do NOT change production code to fit the test).
- If a job's success status is not `'completed'` (e.g. a different terminal label), use the real one; the point is that the per-seed result hash is concurrency-independent.

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/backtester/test/worker-concurrency.test.ts`
Expected: PASS — serial and parallel drains yield identical `{seed -> resultHash}` maps.

- [ ] **Step 3: Full gate**

Run: `pnpm test`
Expected: PASS (entire suite, including the new tests and unchanged momentum/overlay goldens).

- [ ] **Step 4: Commit**

```bash
git add apps/backtester/test/worker-concurrency.test.ts
git commit -m "test(worker): parallel drain is result-identical to serial drain

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- Bounded in-process async concurrency → `runBoundedPool` (Task 1) + `drainQueue` wiring (Task 2). ✓
- `WORKER_CONCURRENCY` default 4, clamp ≥1, `1` = serial, testConfig = 1 → Task 2. ✓
- Claim safety → Postgres unchanged (noted); in-memory CAS proven sufficient, pinned by Task 3 (spec's mutex dropped with documented reasoning). ✓ (deviation flagged)
- Atomic artifact write → Task 4. ✓
- Harness-volume tmp uniqueness → Task 5. ✓
- Determinism invariant; goldens must not move → Task 6 + Task 2 Step 8 + Task 6 Step 3 (`pnpm test`). ✓
- Observability (log concurrency / in-flight) → NOT a task. Gap: the spec's §6 observability is omitted. Decision: deferred as non-essential (the determinism + pool tests prove behavior; a log line adds no verified behavior and risks coupling to a logger). Noted here rather than silently dropped.

**2. Placeholder scan:** No TBD/TODO. The few "match the real literal" notes (submit status code, terminal status, result field) are explicit verification instructions with concrete defaults, not placeholders — required because those values live in unchanged code.

**3. Type consistency:** `runBoundedPool(concurrency, next)` signature identical across Task 1 and Task 2. `drainQueue(deps, concurrency=1)` matches the app.ts call. `AppConfig.workerConcurrency` added in Task 2 and consumed in Task 6 via `buildTestApp({ workerConcurrency })`. `testConfig` gets the field (Task 2) so `buildTestApp` overrides type-check.

## Notes / deferred (per spec, not built)

- Observability log line (spec §6) — deferred; counters/logging add no verified behavior. Easy follow-up.
- The in-memory claim mutex (spec §3) — intentionally not built; the synchronous CAS makes it unnecessary (see "Deviation from spec" above). Pinned by Task 3.
- Worker threads, multi-process workers, Redis/L2, work-stealing, dynamic auto-tuning — out of scope (CPU-bound / multi-replica scale not present).
