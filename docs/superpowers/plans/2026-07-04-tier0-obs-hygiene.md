# Tier 0 Obs Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queue depth in `/statsz`, unconditional bounded `job_error` logging, honest `/v1/capabilities.maxConcurrency`, non-blocking docker teardown, and the merged IPC-profile flag.

**Architecture:** Five additive changes with no schema/flag-default/contract-shape changes. A shared `boundedErrorDetail` helper feeds both the new `job_error` log line and the `/statsz` degraded path. `JobStore` gains one read-only method implemented in both stores. Docker teardown becomes a chained async `dispose` (kill → rm) while `inspectState` stays sync (its only caller, `SandboxSession.mapFailure`, consumes it synchronously for OOM classification — verified).

**Tech Stack:** TypeScript (Node 24, ESM, `.js` import suffixes in apps/backtester), vitest, pg.

**Spec:** `docs/superpowers/specs/2026-07-04-tier0-obs-hygiene-design.md` (rev 2).

## Global Constraints

- No flag-default flips; `BACKTESTER_IPC_PROFILE` stays default OFF; `result_hash` goldens byte-identical.
- `job_error` line is UNCONDITIONAL (not gated on `BACKTESTER_JOB_OBS`).
- `maxConcurrency` = per-process `config.workerConcurrency`; fleet-capacity doc note in OPERATIONS.md.
- Queue stats are queried live per `/statsz` hit (no cache); `/statsz` never 500s because of them.
- Teardown preserves kill → remove ordering via chaining; `inspectState` stays `spawnSync`.
- Pg-gated test for `countQueueStats` is REQUIRED (skipIf pattern, must not fail without a DB).
- Work in `/home/alexxxnikolskiy/projects/trading-backtester` on branch `feat/tier0-obs-hygiene` (created in Task 1). Imports inside `apps/backtester/src` use `.js` suffixes (see existing files). Run single suites with `pnpm vitest run <path>` from `apps/backtester`; full gate `pnpm check` from repo root.

---

### Task 1: Branch + merge `perf/ipc-profile` + `boundedErrorDetail` helper

**Files:**
- Create: `apps/backtester/src/jobs/bounded-error-detail.ts`
- Test: `apps/backtester/test/bounded-error-detail.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `boundedErrorDetail(err: unknown, max = 300): string` — later tasks import it from `../jobs/bounded-error-detail.js` (src) / `../src/jobs/bounded-error-detail.js` (tests).

- [ ] **Step 1: Create the branch carrying the profile commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git checkout -b feat/tier0-obs-hygiene main
git merge --no-edit perf/ipc-profile   # brings b62ca59 (flag-gated instrumentation, sandbox-session.ts only)
git log --oneline -3
```

Expected: merge commits cleanly (single-file addition on top of main).

- [ ] **Step 2: Write the failing test**

```typescript
// apps/backtester/test/bounded-error-detail.test.ts
import { describe, expect, it } from 'vitest';
import { boundedErrorDetail } from '../src/jobs/bounded-error-detail.js';

describe('boundedErrorDetail', () => {
  it('extracts Error messages', () => {
    expect(boundedErrorDetail(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error inputs', () => {
    expect(boundedErrorDetail('raw string')).toBe('raw string');
    expect(boundedErrorDetail(42)).toBe('42');
    expect(boundedErrorDetail(undefined)).toBe('undefined');
  });

  it('normalizes newlines and control chars to single spaces and collapses whitespace', () => {
    expect(boundedErrorDetail(new Error('a\nb\r\n\tc\x00d   e'))).toBe('a b c d e');
  });

  it('truncates to max', () => {
    expect(boundedErrorDetail(new Error('x'.repeat(500)))).toHaveLength(300);
    expect(boundedErrorDetail(new Error('x'.repeat(500)), 50)).toHaveLength(50);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/backtester && pnpm vitest run test/bounded-error-detail.test.ts`
Expected: FAIL — cannot find module `../src/jobs/bounded-error-detail.js`.

- [ ] **Step 4: Implement**

```typescript
// apps/backtester/src/jobs/bounded-error-detail.ts
/** Bounded, log-safe error detail: message extracted, control chars/newlines → single spaces,
 *  whitespace collapsed, truncated to max. Shared by the job_error log line and /statsz. */
export function boundedErrorDetail(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/bounded-error-detail.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/bounded-error-detail.ts apps/backtester/test/bounded-error-detail.test.ts
git commit -m "feat(obs): boundedErrorDetail helper (log-safe truncated error text)"
```

---

### Task 2: `JobStore.countQueueStats` (interface + both stores + conformance tests)

**Files:**
- Modify: `apps/backtester/src/jobs/job-store.ts` (interface at lines 130–171; `InMemoryJobStore` below it)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts` (`PgJobStore`, class at line 137)
- Test: `apps/backtester/test/queue-stats.test.ts` (new, parametrized over `STORE_FACTORIES`)

**Interfaces:**
- Consumes: existing `JobRow` (has `status` and `queuedAtMs`), `STORE_FACTORIES` + `PG_AVAILABLE` from `test/store-factories.ts`.
- Produces: `countQueueStats(nowMs: number): Promise<{ depth: number; oldestQueuedAgeMs: number | null }>` on the `JobStore` interface — Task 3 calls it.

- [ ] **Step 0: Check for other JobStore implementers**

Run: `grep -rn "implements JobStore" apps/backtester --include="*.ts"`
Expected: exactly `InMemoryJobStore` and `PgJobStore`. If a test fake implements the interface, add the same method there (copy the InMemory body).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/queue-stats.test.ts
// countQueueStats conformance over both stores (Pg leg auto-skips without a DB — REQUIRED gate
// pattern, see pg-compute-lock.test.ts). Uses the same STORE_FACTORIES loop as api.e2e.test.ts.
import { describe, expect, it } from 'vitest';
import { STORE_FACTORIES } from './store-factories.js';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`countQueueStats (${factory.name})`, () => {
    it('returns depth 0 and null age on an empty queue', async () => {
      const { store, teardown } = await factory.create();
      try {
        expect(await store.countQueueStats(1_000_000)).toEqual({ depth: 0, oldestQueuedAgeMs: null });
      } finally {
        await teardown();
      }
    });

    it('counts queued jobs and ages from the oldest queued_at_ms', async () => {
      const { store, teardown } = await factory.create();
      try {
        // Follow the NewJob construction used elsewhere in the factory-parametrized suites
        // (see how api.e2e/terminal-result tests build jobs via insertOrGet + transition to queued).
        // Two jobs queued at t=1000 and t=4000; one job left in 'accepted' (must not count).
        // ... build 3 jobs with the file's existing makeNewJob-style helper or inline NewJob literals,
        // transition two of them accepted→queued with queuedAtMs 1000 and 4000 ...
        const stats = await store.countQueueStats(10_000);
        expect(stats.depth).toBe(2);
        expect(stats.oldestQueuedAgeMs).toBe(9_000); // 10_000 - 1000
      } finally {
        await teardown();
      }
    });
  });
}
```

(Adapt the job-construction plumbing to what `store-factories.ts` consumers already do — `insertOrGet` a minimal `NewJob`, then `transition('accepted','queued',{ atMs, queuedAtMs })`-style patch; mirror an existing suite's literals VERBATIM rather than inventing field values. The two assertions — depth excludes non-queued and age derives from the OLDEST `queued_at_ms` — must stay exactly as written.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/queue-stats.test.ts`
Expected: FAIL — `countQueueStats is not a function` (in-memory leg; Pg leg skips without DB).

- [ ] **Step 3: Implement — interface + InMemory**

In `apps/backtester/src/jobs/job-store.ts`, add to the `JobStore` interface (after `get`):

```typescript
  /** Live queue gauge for /statsz (KEDA metric): queued count + age of the oldest queued job. */
  countQueueStats(nowMs: number): Promise<{ depth: number; oldestQueuedAgeMs: number | null }>;
```

`InMemoryJobStore` (next to its `get`, lines ~197–199):

```typescript
  async countQueueStats(nowMs: number): Promise<{ depth: number; oldestQueuedAgeMs: number | null }> {
    let depth = 0;
    let oldest: number | undefined;
    for (const j of this.jobs.values()) {
      if (j.status !== 'queued') continue;
      depth += 1;
      const ts = j.queuedAtMs ?? j.acceptedAtMs;
      if (oldest === undefined || ts < oldest) oldest = ts;
    }
    return { depth, oldestQueuedAgeMs: oldest === undefined ? null : nowMs - oldest };
  }
```

(If `JobRow` field names differ — check the `JobRow` type at job-store.ts:17 — use the row's actual camelCase names; the COALESCE-to-accepted fallback mirrors `claimNextQueued` ordering.)

- [ ] **Step 4: Implement — Pg**

In `apps/backtester/src/jobs/pg-job-store.ts` (next to `get`, lines 182–185):

```typescript
  async countQueueStats(nowMs: number): Promise<{ depth: number; oldestQueuedAgeMs: number | null }> {
    const r = await this.pool.query<{ depth: string; oldest: string | null }>(
      "SELECT count(*)::text AS depth, min(COALESCE(queued_at_ms, accepted_at_ms))::text AS oldest FROM backtest_job WHERE status = 'queued'",
    );
    const row = r.rows[0];
    const depth = row ? Number.parseInt(row.depth, 10) : 0;
    const oldest = row?.oldest == null ? null : Number.parseInt(row.oldest, 10);
    return { depth, oldestQueuedAgeMs: oldest === null ? null : nowMs - oldest };
  }
```

(Pg bigint comes back as string — hence `::text` + parseInt, same coercion concern as the file's `num` helper at lines 68–69; reuse that helper if it fits.)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/queue-stats.test.ts` — in-memory PASS, Pg leg skipped or PASS.
Then, with the local Pg up (measurement stand DB works):
`BACKTESTER_TEST_DATABASE_URL=postgres://lab:lab@127.0.0.1:5432/backtester_perf pnpm vitest run test/queue-stats.test.ts`
Expected: BOTH legs PASS (the Pg-gated leg is REQUIRED to be seen green at least once — paste its output in the report).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/queue-stats.test.ts
git commit -m "feat(obs): JobStore.countQueueStats — live queue depth + oldest-queued age (both stores)"
```

---

### Task 3: `/statsz` queue block

**Files:**
- Modify: `apps/backtester/src/jobs/worker-health.ts` (full current file is 51 lines — see snippet below)
- Modify: the `startWorkerHealthServer(...)` call site (find it: `grep -rn "startWorkerHealthServer(" apps/backtester/src` — expected in `src/worker-main.ts` and possibly `src/app.ts`; wire the new arg where a `JobStore` is in scope)
- Test: `apps/backtester/test/worker-health-statsz.test.ts` (extend; current setup pattern shown below)

**Interfaces:**
- Consumes: `countQueueStats` (Task 2), `boundedErrorDetail` (Task 1).
- Produces: `/statsz` JSON gains top-level `queue: { depth, oldestQueuedAgeMs } | { error: string }`.

Current handler (worker-health.ts):

```typescript
    } else if (req.url === '/statsz') {
      if (stats) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats.snapshot()));
      } else {
        res.writeHead(404).end();
      }
    } else {
```

- [ ] **Step 1: Write the failing tests**

Extend `test/worker-health-statsz.test.ts` (existing pattern: `startWorkerHealthServer(0, state, obs)` + `fetch`):

```typescript
  it('adds a queue block when a queueStats provider is given', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs, async () => ({ depth: 5, oldestQueuedAgeMs: 1234 }));
    close = srv.close;
    const body = (await (await fetch(`http://127.0.0.1:${srv.port}/statsz`)).json()) as { queue?: unknown };
    expect(body.queue).toEqual({ depth: 5, oldestQueuedAgeMs: 1234 });
  });

  it('degrades the queue block to a bounded error and still serves 200', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs, async () => { throw new Error('pg down\nline2'); });
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue?: { error?: string } };
    expect(body.queue).toEqual({ error: 'pg down line2' });
  });

  it('omits the queue block when no provider is given (back-compat)', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs);
    close = srv.close;
    const body = (await (await fetch(`http://127.0.0.1:${srv.port}/statsz`)).json()) as { queue?: unknown };
    expect(body.queue).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run test/worker-health-statsz.test.ts`
Expected: new tests FAIL (extra-arg signature / no queue block); pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `worker-health.ts`: add the provider type + 4th param and make the `/statsz` branch async-safe:

```typescript
export type QueueStatsProvider = (nowMs: number) => Promise<{ depth: number; oldestQueuedAgeMs: number | null }>;
```

```typescript
export async function startWorkerHealthServer(
  port: number,
  state: WorkerHealthState,
  stats?: StatsProvider,
  queueStats?: QueueStatsProvider,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.live() ? 200 : 503).end();
    } else if (req.url === '/readyz') {
      res.writeHead(state.ready() ? 200 : 503).end();
    } else if (req.url === '/statsz') {
      if (stats) {
        const base = stats.snapshot() as Record<string, unknown>;
        void (async () => {
          let queue: unknown;
          if (queueStats) {
            try {
              queue = await queueStats(Date.now());
            } catch (err) {
              queue = { error: boundedErrorDetail(err) };
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(queue === undefined ? base : { ...base, queue }));
        })();
      } else {
        res.writeHead(404).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });
```

Import: `import { boundedErrorDetail } from './bounded-error-detail.js';`

- [ ] **Step 4: Wire the call site(s)**

`grep -rn "startWorkerHealthServer(" apps/backtester/src` — at each production call site where a `JobStore` is in scope (worker-main/app), pass:

```typescript
      (nowMs) => store.countQueueStats(nowMs),
```

as the 4th argument (keep existing args untouched; do NOT wire it where no store exists).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/worker-health-statsz.test.ts && pnpm typecheck` (or `npx tsc --noEmit -p apps/backtester` from repo root)
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/worker-health.ts apps/backtester/src/worker-main.ts apps/backtester/test/worker-health-statsz.test.ts
git commit -m "feat(obs): /statsz queue block — live depth + oldest-queued age, bounded degraded path"
```

(Adjust the `git add` list to the actual wired call-site files.)

---

### Task 4: Honest `/v1/capabilities.maxConcurrency` + OPERATIONS note

**Files:**
- Modify: `apps/backtester/src/app.ts` (line 199: `maxConcurrency: 1,` inside the `buildServer({...})` call)
- Modify: `docs/OPERATIONS.md` (capacity-budget section)
- Test: `apps/backtester/test/api.e2e.test.ts` (extend the `reports capabilities` test at lines ~100–110)

**Interfaces:**
- Consumes: existing `config.workerConcurrency` (AppConfig, default 4 — already used at app.ts:145).
- Produces: none downstream.

- [ ] **Step 1: Write the failing test**

In `api.e2e.test.ts`, extend the existing `reports capabilities` test. `makeApp(factory)` builds the app — check its signature in `test/helpers.ts`; it constructs an `AppConfig`. Pass/override `workerConcurrency: 3` through whatever override mechanism `makeApp`/`buildApp` exposes (helpers construct config directly — add the field to the literal or an options param, following the file's existing override style). Then:

```typescript
        const caps = (await app.server.inject({ url: '/v1/capabilities', headers: AUTH })).json() as {
          contractVersion: string;
          maxConcurrency: number;
        };
        expect(caps.contractVersion).toBe('017.2');
        expect(caps.maxConcurrency).toBe(3); // concrete injected value — not just "a number"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/api.e2e.test.ts -t "reports capabilities"`
Expected: FAIL — `maxConcurrency` is 1.

- [ ] **Step 3: Implement**

app.ts line 199: `maxConcurrency: 1,` → `maxConcurrency: config.workerConcurrency,`

- [ ] **Step 4: OPERATIONS doc note**

In `docs/OPERATIONS.md`, in the capacity-budget / horizontal-scaling section, add one paragraph:

```markdown
`GET /v1/capabilities` reports `maxConcurrency` as the **per-worker-process** concurrency
(`WORKER_CONCURRENCY` of the API process's config). It is NOT fleet-wide capacity: in split
topology the API cannot see how many worker replicas exist. Fleet capacity = `worker_pods ×
WORKER_CONCURRENCY` — see the capacity-budget formula above.
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/api.e2e.test.ts`
Expected: PASS (both store-factory legs; Pg leg may skip).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/test/api.e2e.test.ts docs/OPERATIONS.md
git commit -m "fix(api): /v1/capabilities reports real per-process workerConcurrency (was hardcoded 1)"
```

---

### Task 5: Unconditional `job_error` + `errorDetail` in `job_terminal`

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` — the catch at ~line 637 and the obs block at ~lines 663–683
- Modify: `apps/backtester/src/jobs/obs-registry.ts` — `JobObsSample` type gains optional `errorDetail`
- Test: `apps/backtester/test/worker-error-visibility.test.ts` (new; follow the construction style of an existing worker test — find one with `grep -ln "processNextQueued" apps/backtester/test`)

**Interfaces:**
- Consumes: `boundedErrorDetail` (Task 1).
- Produces: log lines only; `JobObsSample.errorDetail?: string`.

Current catch (worker.ts:637):

```typescript
  } catch (err) {
    const code = err instanceof RunnerError ? err.code : 'runner_failure';
    const terminalStatus = err instanceof RunnerError ? err.terminalStatus : 'failed';
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/worker-error-visibility.test.ts — shape (adapt deps construction from an
// existing processNextQueued test):
// 1. Arrange a job whose engine/executor throws new Error('X'.repeat(400) + '\nsecond line').
// 2. Spy: const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
// 3. Run processNextQueued WITHOUT obs (deps.obs undefined).
// 4. Assert one call whose JSON-parsed arg matches:
//    { evt: 'job_error', runId: <the run>, code: 'runner_failure', detail: expect.stringMatching(/^X{298} s/) }
//    and detail.length <= 300 and detail contains NO '\n'.
// 5. Re-run WITH obs (ObsRegistry) and a console.log spy: the job_terminal line JSON-parses to an
//    object with errorDetail === the same bounded string.
```

Write it as real code against the existing worker-test fixture (the file you found via grep has the deps assembly to copy — mirror it verbatim, only swapping the failing executor in).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker-error-visibility.test.ts`
Expected: FAIL — no `job_error` console.error call.

- [ ] **Step 3: Implement**

worker.ts — in `processNextQueued`, add near the top of the function scope: `let caughtErrorDetail: string | undefined;`
Catch block:

```typescript
  } catch (err) {
    caughtErrorDetail = boundedErrorDetail(err);
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      evt: 'job_error',
      runId,
      code: err instanceof RunnerError ? err.code : 'runner_failure',
      detail: caughtErrorDetail,
    }));
    const code = err instanceof RunnerError ? err.code : 'runner_failure';
```

Obs sample (lines ~666–677) — add after `totalMs`:

```typescript
        ...(caughtErrorDetail !== undefined ? { errorDetail: caughtErrorDetail } : {}),
```

`obs-registry.ts` — `JobObsSample` gains:

```typescript
  /** Bounded error detail (boundedErrorDetail) when the job failed with a thrown error. */
  readonly errorDetail?: string;
```

Import in worker.ts: `import { boundedErrorDetail } from './bounded-error-detail.js';`

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/worker-error-visibility.test.ts && pnpm vitest run test/worker-health-statsz.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/jobs/obs-registry.ts apps/backtester/test/worker-error-visibility.test.ts
git commit -m "feat(obs): unconditional bounded job_error line + errorDetail in job_terminal"
```

---

### Task 6: Async docker teardown (`dispose`, kill → rm chained)

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/docker-driver.ts` (kill/remove at lines 104–112; import at line 11 already has both `spawn` and `spawnSync`)
- Modify: `apps/backtester/src/engine/sandbox/sandbox-session.ts` (`close()` — currently calls `this.driver.kill(c.name); this.driver.remove(c.name);`)
- Test: `apps/backtester/test/docker-driver-dispose.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DockerDriver.dispose(name: string): void` — async chained kill → rm, errors swallowed. `kill`/`remove` (sync) remain for any other callers; `inspectState` UNTOUCHED (sync, load-bearing in `mapFailure` OOM classification — verified single caller at sandbox-session.ts:220).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/docker-driver-dispose.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnCalls: string[][] = [];
const children: EventEmitter[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      children.push(child);
      return child;
    }),
  };
});

const { DockerDriver } = await import('../src/engine/sandbox/docker-driver.js');

describe('DockerDriver.dispose', () => {
  beforeEach(() => { spawnCalls.length = 0; children.length = 0; });

  it('spawns kill first and rm only after kill closes (ordering preserved)', async () => {
    const driver = new DockerDriver();
    driver.dispose('bt-x');
    expect(spawnCalls).toEqual([['docker', 'kill', '-s', 'KILL', 'bt-x']]);
    children[0]!.emit('close', 0);
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls[1]).toEqual(['docker', 'rm', '-f', 'bt-x']);
  });

  it('still spawns rm when kill errors (best-effort)', async () => {
    const driver = new DockerDriver();
    driver.dispose('bt-y');
    children[0]!.emit('error', new Error('spawn ENOENT'));
    children[0]!.emit('close', 1);
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls[1]).toEqual(['docker', 'rm', '-f', 'bt-y']);
  });
});
```

(If `DockerDriver`'s constructor needs args, mirror how existing driver tests construct it — check `grep -ln "new DockerDriver" apps/backtester/test apps/backtester/src`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/docker-driver-dispose.test.ts`
Expected: FAIL — `dispose is not a function`.

- [ ] **Step 3: Implement**

docker-driver.ts, after `remove`:

```typescript
  /** Асинхронный best-effort teardown: kill → (по завершении) rm, ошибки проглатываются.
   *  Не блокирует event loop (в отличие от sync kill/remove) — используется на пути close(). */
  dispose(name: string): void {
    const kill = spawn('docker', ['kill', '-s', 'KILL', name], { stdio: 'ignore' });
    kill.unref?.();
    kill.on('error', () => {});
    kill.on('close', () => {
      const rm = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
      rm.unref?.();
      rm.on('error', () => {});
    });
  }
```

sandbox-session.ts `close()`:

```typescript
    this.driver.kill(c.name);
    this.driver.remove(c.name);
```
→
```typescript
    this.driver.dispose(c.name);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/docker-driver-dispose.test.ts` — PASS.
Then the sandbox suites that exercise close/mapFailure paths (Docker-gated ones skip on WSL2 — that's expected):
`pnpm vitest run test/ --dir apps/backtester -t sandbox` or simply proceed to the full gate in Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/docker-driver.ts apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/test/docker-driver-dispose.test.ts
git commit -m "perf(sandbox): async chained container teardown (dispose kill→rm), event loop unblocked"
```

---

### Task 7: Full gate + profile default-off verification + wrap-up

**Files:** none new.

- [ ] **Step 1: Profile default-off check**

Run: `grep -rn "BACKTESTER_IPC_PROFILE" apps/backtester/src` — must appear ONLY in sandbox-session.ts as `=== 'true'` gate. Then confirm no `ipc_profile` output in default runs: the full suite (next step) runs with the env unset; grep its output for `ipc_profile` — expected zero occurrences.

- [ ] **Step 2: Full gate**

Run: `pnpm check` (repo root)
Expected: typecheck + full vitest green; `result_hash` golden suites untouched and green. Docker-gated suites skip on WSL2 (CI is the sandbox gate).

- [ ] **Step 3: Diff scope check**

Run: `git diff main --stat`
Confirm: only `apps/backtester/src/jobs/{bounded-error-detail,job-store,pg-job-store,worker-health,worker,obs-registry}.ts`, `apps/backtester/src/engine/sandbox/{docker-driver,sandbox-session}.ts`, `apps/backtester/src/app.ts`, `apps/backtester/src/worker-main.ts` (if wired there), the new/extended test files, `docs/OPERATIONS.md` — plus the merged profile commit's sandbox-session.ts changes.

- [ ] **Step 4: Finish**

Use superpowers:finishing-a-development-branch — PR `feat/tier0-obs-hygiene` (repo convention: squash-merge PRs).
