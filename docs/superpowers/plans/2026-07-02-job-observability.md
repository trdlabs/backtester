# Job Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add minimal, flag-gated per-job observability (structured terminal log line + `/statsz` in-process counters) so `BACKTESTER_DEDUP_ENABLED=true` can be enabled in a controlled setting and its effect measured.

**Architecture:** A single instrumentation site in `processNextQueued` gathers per-job timing (queue-wait / materialize / engine / total) and a dedup classification, then — only when a `deps.obs` registry is present — emits one JSON log line and records into an in-memory `ObsRegistry`. The registry's snapshot is served as `/statsz` by the existing worker health server. Everything is gated behind a new `BACKTESTER_JOB_OBS` flag (default off); with it off, no extra `deps.clock()` calls happen, so existing byte-equivalence goldens are unaffected.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `node:http` (existing worker health server), bare `console.log` (no logging library).

## Global Constraints

- Flag `BACKTESTER_JOB_OBS`, default **off** (`env.BACKTESTER_JOB_OBS === 'true'`), same pattern as `BACKTESTER_DEDUP_ENABLED`.
- All timing `deps.clock()` calls MUST be inside an `if (deps.obs)` / `deps.obs !== undefined` guard. Flag off ⇒ zero additional clock calls vs today.
- No new dependencies. No Prometheus / OpenTelemetry / logging library / dashboards.
- No `JobStore` surface change. Queue depth is NOT instrumented (SQL-documented only).
- No percentiles — `count` / `sum` / `max` per phase only.
- `/statsz` is served ONLY by the worker health server (`worker-health.ts`) in this slice. No route added to the public API server.
- Observability must never change a job's outcome: emission/recording is best-effort (wrapped so a throw cannot fail a job) and runs after the terminal transition.
- ESM import specifiers end in `.js`. Follow existing file/test patterns.

---

### Task 1: `ObsRegistry` (pure in-memory counters)

**Files:**
- Create: `apps/backtester/src/jobs/obs-registry.ts`
- Test: `apps/backtester/test/obs-registry.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type DedupClass = 'off' | 'evidence_bypass' | 'bypass' | 'hit' | 'miss' | 'stale_recompute'`
  - `interface JobObsSample { runId: string; engine: string; outcome: string; terminalCode?: string; dedup: DedupClass; queueWaitMs: number | null; materializeMs: number | null; engineMs: number | null; totalMs: number; }`
  - `interface PhaseStat { count: number; sum: number; max: number; }`
  - `interface JobObsSnapshot { startedAtMs: number; jobs: { total: number; byOutcome: Record<string, number> }; dedup: Record<DedupClass, number>; phases: { queueWaitMs: PhaseStat; materializeMs: PhaseStat; engineMs: PhaseStat; totalMs: PhaseStat }; }`
  - `class ObsRegistry { constructor(startedAtMs: number); recordJob(s: JobObsSample): void; snapshot(): JobObsSnapshot; }`
  - Phase stats fold only **non-null** phase values (so `engineMs: null` on a hit is not counted).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/obs-registry.test.ts
import { describe, expect, it } from 'vitest';
import { ObsRegistry, type JobObsSample } from '../src/jobs/obs-registry.js';

const base: JobObsSample = {
  runId: 'r1', engine: 'momentum', outcome: 'completed',
  dedup: 'miss', queueWaitMs: 10, materializeMs: 40, engineMs: 100, totalMs: 150,
};

describe('ObsRegistry', () => {
  it('counts jobs by outcome and dedup class', () => {
    const reg = new ObsRegistry(1000);
    reg.recordJob(base);
    reg.recordJob({ ...base, runId: 'r2', outcome: 'failed', dedup: 'hit', engineMs: null });
    const s = reg.snapshot();
    expect(s.startedAtMs).toBe(1000);
    expect(s.jobs.total).toBe(2);
    expect(s.jobs.byOutcome).toEqual({ completed: 1, failed: 1 });
    expect(s.dedup.miss).toBe(1);
    expect(s.dedup.hit).toBe(1);
    expect(s.dedup.off).toBe(0);
  });

  it('folds count/sum/max per phase and skips null phase values', () => {
    const reg = new ObsRegistry(0);
    reg.recordJob({ ...base, queueWaitMs: 10, materializeMs: 40, engineMs: 100, totalMs: 150 });
    reg.recordJob({ ...base, runId: 'r2', dedup: 'hit', queueWaitMs: 20, materializeMs: 60, engineMs: null, totalMs: 90 });
    const s = reg.snapshot();
    expect(s.phases.queueWaitMs).toEqual({ count: 2, sum: 30, max: 20 });
    expect(s.phases.materializeMs).toEqual({ count: 2, sum: 100, max: 60 });
    expect(s.phases.engineMs).toEqual({ count: 1, sum: 100, max: 100 }); // hit's null engineMs skipped
    expect(s.phases.totalMs).toEqual({ count: 2, sum: 240, max: 150 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/obs-registry.test.ts`
Expected: FAIL — cannot find module `../src/jobs/obs-registry.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/jobs/obs-registry.ts
// Minimal in-memory job observability counters. No histogram/percentiles — count/sum/max per phase.
// Constructed only when BACKTESTER_JOB_OBS is on, so it never affects the flag-off (golden) path.

export type DedupClass = 'off' | 'evidence_bypass' | 'bypass' | 'hit' | 'miss' | 'stale_recompute';

export interface JobObsSample {
  runId: string;
  engine: string;
  outcome: string;
  terminalCode?: string;
  dedup: DedupClass;
  queueWaitMs: number | null;
  materializeMs: number | null;
  engineMs: number | null;
  totalMs: number;
}

export interface PhaseStat {
  count: number;
  sum: number;
  max: number;
}

export interface JobObsSnapshot {
  startedAtMs: number;
  jobs: { total: number; byOutcome: Record<string, number> };
  dedup: Record<DedupClass, number>;
  phases: { queueWaitMs: PhaseStat; materializeMs: PhaseStat; engineMs: PhaseStat; totalMs: PhaseStat };
}

const DEDUP_CLASSES: DedupClass[] = ['off', 'evidence_bypass', 'bypass', 'hit', 'miss', 'stale_recompute'];

function emptyPhase(): PhaseStat {
  return { count: 0, sum: 0, max: 0 };
}

function fold(stat: PhaseStat, value: number | null): void {
  if (value === null) return;
  stat.count += 1;
  stat.sum += value;
  if (value > stat.max) stat.max = value;
}

export class ObsRegistry {
  private total = 0;
  private readonly byOutcome: Record<string, number> = {};
  private readonly dedup: Record<DedupClass, number>;
  private readonly phases = {
    queueWaitMs: emptyPhase(),
    materializeMs: emptyPhase(),
    engineMs: emptyPhase(),
    totalMs: emptyPhase(),
  };

  constructor(private readonly startedAtMs: number) {
    this.dedup = Object.fromEntries(DEDUP_CLASSES.map((c) => [c, 0])) as Record<DedupClass, number>;
  }

  recordJob(s: JobObsSample): void {
    this.total += 1;
    this.byOutcome[s.outcome] = (this.byOutcome[s.outcome] ?? 0) + 1;
    this.dedup[s.dedup] += 1;
    fold(this.phases.queueWaitMs, s.queueWaitMs);
    fold(this.phases.materializeMs, s.materializeMs);
    fold(this.phases.engineMs, s.engineMs);
    fold(this.phases.totalMs, s.totalMs);
  }

  snapshot(): JobObsSnapshot {
    return {
      startedAtMs: this.startedAtMs,
      jobs: { total: this.total, byOutcome: { ...this.byOutcome } },
      dedup: { ...this.dedup },
      phases: {
        queueWaitMs: { ...this.phases.queueWaitMs },
        materializeMs: { ...this.phases.materializeMs },
        engineMs: { ...this.phases.engineMs },
        totalMs: { ...this.phases.totalMs },
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/obs-registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/obs-registry.ts apps/backtester/test/obs-registry.test.ts
git commit -m "feat(obs): ObsRegistry — in-memory per-job counters (count/sum/max per phase)"
```

---

### Task 2: `BACKTESTER_JOB_OBS` config flag

**Files:**
- Modify: `apps/backtester/src/config.ts` (add `jobObs` to `AppConfig` interface ~line 100; add parse in `loadConfig` ~line 229, next to `dedupEnabled`)
- Test: `apps/backtester/test/config-job-obs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig.jobObs: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/config-job-obs.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_JOB_OBS config', () => {
  it('defaults to false', () => {
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: undefined } as NodeJS.ProcessEnv).jobObs).toBe(false);
  });
  it('is true only for the exact string "true"', () => {
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: 'true' } as NodeJS.ProcessEnv).jobObs).toBe(true);
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: '1' } as NodeJS.ProcessEnv).jobObs).toBe(false);
  });
});
```

> Note: mirror the exact `loadConfig` call signature used by the sibling `config-dedup.test.ts` (it already exercises `BACKTESTER_DEDUP_ENABLED`). If `loadConfig` reads `process.env` directly rather than taking an arg, copy that test's env-override pattern (save/restore `process.env`) instead of passing an env object.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/config-job-obs.test.ts`
Expected: FAIL — `jobObs` is `undefined` / not on `AppConfig`.

- [ ] **Step 3: Write minimal implementation**

In `apps/backtester/src/config.ts`, add to the `AppConfig` interface (next to `readonly dedupEnabled: boolean;`):

```ts
  /** Enable per-job observability (terminal log line + /statsz). Default off. */
  readonly jobObs: boolean;
```

In `loadConfig`, add next to `dedupEnabled: env.BACKTESTER_DEDUP_ENABLED === 'true',`:

```ts
    jobObs: env.BACKTESTER_JOB_OBS === 'true',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/config-job-obs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-job-obs.test.ts
git commit -m "feat(obs): BACKTESTER_JOB_OBS config flag (default off)"
```

---

### Task 3: Instrument `processNextQueued` (timing + dedup class + emit)

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`WorkerDeps` interface ~line 64; `processNextQueued` ~line 300–530)
- Test: `apps/backtester/test/obs-worker.test.ts`

**Interfaces:**
- Consumes: `ObsRegistry`, `JobObsSample`, `DedupClass` from Task 1; `WorkerDeps` (adds `obs?`).
- Produces: `WorkerDeps.obs?: ObsRegistry`; a `job_terminal` JSON line on `console.log`; `deps.obs.recordJob(sample)` per terminal job.

**Design notes for this task (read before editing):**
- Timing locals are captured ONLY when `deps.obs` is set. On a fresh momentum run (a miss) exactly 4 obs clock calls happen: `tClaim`, `tMaterialized`, `tEngineDone`, `tTerminal`. On a hit: 3 (no `tEngineDone`).
- `claimed` is a `JobRow`; queue timestamp is `claimed.queuedAtMs` (may be `undefined` ⇒ `queueWaitMs: null`).
- `engine` used for the sample is `claimed.request.engine ?? 'momentum'` (stable even if a failure precedes materialize).
- Terminal status/code come from the re-fetched `finished` row (already fetched at the end of the function).
- Dedup classification, computed at the gate:
  - `deps.dedupEnabled === true && deps.resultCache !== undefined && claimed.request.curatedBaselineRef !== undefined` → `evidence_bypass`
  - else `!dedupOn` → `off`
  - else `!doLookup` (bypassCache) → `bypass`
  - else lookup hit re-stamped → `hit`; hit rejected (template mismatch OR read threw) → `stale_recompute`; no hit → `miss`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/obs-worker.test.ts
// Mirrors dedup-worker.test.ts's momentum harness (makeCtx/momentumJob/enqueue) but wires an ObsRegistry
// into deps and asserts the dedup classification, duration breakdown, and the flag-off invariant.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';
// ... reuse the same imports/fixtures as dedup-worker.test.ts (InMemoryJobStore, InMemoryResultCache,
//     InMemoryArtifactStore, InMemoryBundleStore, FixtureDataPort, loadConfig, REQ, momentumJob, enqueue) ...

// Extend the local makeCtx helper (copied from dedup-worker.test.ts) to accept an obs registry:
//   function makeCtx(opts: { dedupEnabled?: boolean; obs?: ObsRegistry } = {}): Ctx {
//     ... existing deps ... return { store, cache, deps: { ...deps, ...(opts.obs ? { obs: opts.obs } : {}) } };
//   }

afterEach(() => vi.restoreAllMocks());

describe('worker observability — momentum', () => {
  it('records a miss with full duration breakdown and emits one job_terminal line', async () => {
    const obs = new ObsRegistry(0);
    const recordSpy = vi.spyOn(obs, 'recordJob');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, deps } = makeCtx({ dedupEnabled: true, obs });
    await enqueue(store, 'run-obs-1');
    await processNextQueued(deps);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const sample = recordSpy.mock.calls[0][0];
    expect(sample.dedup).toBe('miss');
    expect(sample.outcome).toBe('completed');
    expect(sample.engineMs).not.toBeNull();       // miss recomputes → engine ran
    expect(sample.materializeMs).not.toBeNull();
    expect(sample.totalMs).toBeGreaterThanOrEqual(0);

    // exactly one structured terminal line, tagged job_terminal
    const terminalLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_terminal"'));
    expect(terminalLines).toHaveLength(1);
    expect(JSON.parse(terminalLines[0]).dedup).toBe('miss');
  });

  it('classifies a second identical run as a hit with engineMs null', async () => {
    const obs = new ObsRegistry(0);
    const recordSpy = vi.spyOn(obs, 'recordJob');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, deps } = makeCtx({ dedupEnabled: true, obs });
    await enqueue(store, 'run-obs-A');
    await processNextQueued(deps);
    await enqueue(store, 'run-obs-B');
    await processNextQueued(deps);

    const second = recordSpy.mock.calls[1][0];
    expect(second.dedup).toBe('hit');
    expect(second.engineMs).toBeNull();           // hit skips the engine
  });

  it('flag off: no log line, no clock overhead, outcome unchanged', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // obs OFF
    const off = makeCtx({ dedupEnabled: true });
    await enqueue(off.store, 'run-off');
    await processNextQueued(off.deps);
    const offJob = await off.store.get('run-off');
    const terminalOff = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('job_terminal'));
    expect(terminalOff).toHaveLength(0);          // no emission when obs absent
    expect(offJob?.status).toBe('completed');     // outcome intact
  });

  it('flag on adds exactly 4 clock calls on a momentum miss vs flag off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let offCalls = 0;
    const off = makeCtx({ dedupEnabled: true });
    off.deps.clock = () => { offCalls += 1; return 1_700_000_000_000 + offCalls; };
    await enqueue(off.store, 'run-c-off');
    await processNextQueued(off.deps);

    let onCalls = 0;
    const obs = new ObsRegistry(0);
    const on = makeCtx({ dedupEnabled: true, obs });
    on.deps.clock = () => { onCalls += 1; return 1_700_000_000_000 + onCalls; };
    await enqueue(on.store, 'run-c-on');
    await processNextQueued(on.deps);

    expect(onCalls - offCalls).toBe(4);           // tClaim + tMaterialized + tEngineDone + tTerminal
  });
});
```

> Note: `makeCtx`/`momentumJob`/`enqueue`/`REQ` are copied from `dedup-worker.test.ts` (momentum, Docker-free). If `deps.clock` is `readonly` in the type, build the ctx with an overridable clock closure the same way `dedup-worker.test.ts` does (it uses a fixed `CLOCK`); replace it with the counting closure before calling `processNextQueued`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/obs-worker.test.ts`
Expected: FAIL — `deps.obs` not consumed; no `job_terminal` line; `recordJob` never called.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `apps/backtester/src/jobs/worker.ts`, add the import at the top:

```ts
import { ObsRegistry, type DedupClass, type JobObsSample } from './obs-registry.js';
```

**3b.** Add to the `WorkerDeps` interface (next to `dedupEnabled?: boolean;`):

```ts
  /** Per-job observability registry. Absent ⇒ observability is OFF (no timing, no log line). */
  obs?: ObsRegistry;
```

**3c.** In `processNextQueued`, immediately after `const runId = claimed.runId;`, add the timing locals:

```ts
  const tClaim = deps.obs ? deps.clock() : undefined;
  let tMaterialized: number | undefined;
  let tEngineDone: number | undefined;
  let dedupClass: DedupClass = 'off';
```

**3d.** Right after `const engine = materialized.engine;` (the end of the materialize block), capture:

```ts
    if (deps.obs) tMaterialized = deps.clock();
```

**3e.** At the dedup gate, classify. Replace the existing gate preamble — keep the existing `dedupOn` / `doLookup` lines — and add classification right after them:

```ts
    if (deps.dedupEnabled === true && deps.resultCache !== undefined && claimed.request.curatedBaselineRef !== undefined) {
      dedupClass = 'evidence_bypass';
    } else if (!dedupOn) {
      dedupClass = 'off';
    } else if (!doLookup) {
      dedupClass = 'bypass';
    } else {
      dedupClass = 'miss'; // refined below to 'hit' / 'stale_recompute' by the lookup
    }
```

In the lookup block: when the template matches and `finalized` is set (the re-stamp branch), add `dedupClass = 'hit';`. In BOTH rejection branches (the `else` after the `template.engine === engine && ...` check, and the `catch`), add `dedupClass = 'stale_recompute';`. (The plain no-hit case keeps `'miss'`.)

**3f.** On the miss path, capture engine-done. After the engine has run and `finalized` is set but before/after the cache-populate block, add:

```ts
      if (deps.obs) tEngineDone = deps.clock();
```

(Place it inside the `if (!finalized) { ... }` block, after the engine branches set `finalized`, so a hit — which never enters this block — leaves `tEngineDone` undefined.)

**3g.** Emit + record at the very end, replacing the tail `const finished = await deps.store.get(runId); if (finished) await publishCompletion(deps, finished); return finished;` with:

```ts
  const finished = await deps.store.get(runId);

  if (deps.obs && tClaim !== undefined) {
    try {
      const tTerminal = deps.clock();
      const sample: JobObsSample = {
        runId,
        engine: claimed.request.engine ?? 'momentum',
        outcome: finished?.status ?? 'unknown',
        ...(finished?.terminalCode !== undefined ? { terminalCode: finished.terminalCode } : {}),
        dedup: dedupClass,
        queueWaitMs: claimed.queuedAtMs !== undefined ? tClaim - claimed.queuedAtMs : null,
        materializeMs: tMaterialized !== undefined ? tMaterialized - tClaim : null,
        engineMs: tEngineDone !== undefined && tMaterialized !== undefined ? tEngineDone - tMaterialized : null,
        totalMs: tTerminal - tClaim,
      };
      deps.obs.recordJob(sample);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ evt: 'job_terminal', ...sample, ts: tTerminal }));
    } catch {
      // Observability is best-effort: it must never fail a job.
    }
  }

  if (finished) await publishCompletion(deps, finished);
  return finished;
```

> If `claimed.request.engine` is typed as a required union without `'momentum'`, use `(claimed.request.engine as string | undefined) ?? 'momentum'`. If `finished.terminalCode` is not a field on `JobRow`, drop the `terminalCode` spread (verify the field name via the `catch` block's `transition(..., { terminalCode: code })` patch and its `JobRow` type).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/obs-worker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the dedup goldens to confirm no regression**

Run: `pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts apps/backtester/test/dedup-worker.test.ts`
Expected: PASS (unchanged; obs off in those suites).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/obs-worker.test.ts
git commit -m "feat(obs): instrument processNextQueued — timing + dedup class + job_terminal line"
```

---

### Task 4: `/statsz` on the worker health server

**Files:**
- Modify: `apps/backtester/src/jobs/worker-health.ts` (`startWorkerHealthServer` ~line 14)
- Test: `apps/backtester/test/worker-health-statsz.test.ts`

**Interfaces:**
- Consumes: a `StatsProvider` (structural) — `{ snapshot(): unknown }`; `ObsRegistry` satisfies it.
- Produces: `startWorkerHealthServer(port, state, stats?)` — new optional 3rd param; `GET /statsz` → `200` + `JSON.stringify(stats.snapshot())` when `stats` is present, `404` otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/worker-health-statsz.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { startWorkerHealthServer } from '../src/jobs/worker-health.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const state = { live: () => true, ready: () => true };

describe('worker health /statsz', () => {
  it('serves the ObsRegistry snapshot when a provider is given', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs);
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.startedAtMs).toBe(1234);
    expect(body.jobs.total).toBe(0);
  });

  it('404s /statsz when no provider is given', async () => {
    const srv = await startWorkerHealthServer(0, state);
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/worker-health-statsz.test.ts`
Expected: FAIL — `/statsz` returns 404 even with a provider (arg not accepted yet).

- [ ] **Step 3: Write minimal implementation**

In `apps/backtester/src/jobs/worker-health.ts`, add the provider type and the route. Update the signature and the request handler:

```ts
export interface StatsProvider {
  snapshot(): unknown;
}

export async function startWorkerHealthServer(
  port: number,
  state: WorkerHealthState,
  stats?: StatsProvider,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.live() ? 200 : 503).end();
    } else if (req.url === '/readyz') {
      res.writeHead(state.ready() ? 200 : 503).end();
    } else if (req.url === '/statsz') {
      if (stats) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats.snapshot()));
      } else {
        res.writeHead(404).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });
  // ... unchanged listen/close ...
```

(Leave the `listen` / `close` tail exactly as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/worker-health-statsz.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/worker-health.ts apps/backtester/test/worker-health-statsz.test.ts
git commit -m "feat(obs): serve /statsz snapshot from the worker health server"
```

---

### Task 5: Wire `ObsRegistry` through `buildApp` + `worker-main`, and document

**Files:**
- Modify: `apps/backtester/src/app.ts` (`buildApp` ~line 60–130, `workerDeps` construction)
- Modify: `apps/backtester/src/worker-main.ts` (`main` ~line 19, `startWorkerHealthServer` call)
- Modify: `docs/OPERATIONS.md` (add a "Job observability" subsection)
- Test: `apps/backtester/test/app-obs-wiring.test.ts`

**Interfaces:**
- Consumes: `ObsRegistry` (Task 1), `AppConfig.jobObs` (Task 2), `WorkerDeps.obs` (Task 3), `startWorkerHealthServer(port, state, stats?)` (Task 4).
- Produces: `buildApp` sets `workerDeps.obs` iff `config.jobObs`; `worker-main` passes `deps.obs` as the health server's stats provider.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/app-obs-wiring.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

describe('buildApp obs wiring', () => {
  it('sets workerDeps.obs when jobObs is on', async () => {
    const app = await buildApp({ ...loadConfig(), jobObs: true, databaseUrl: undefined, autoWorker: false });
    dispose = app.dispose;
    expect(app.workerDeps.obs).toBeInstanceOf(ObsRegistry);
  });
  it('leaves workerDeps.obs undefined when jobObs is off', async () => {
    const app = await buildApp({ ...loadConfig(), jobObs: false, databaseUrl: undefined, autoWorker: false });
    dispose = app.dispose;
    expect(app.workerDeps.obs).toBeUndefined();
  });
});
```

> Note: match how sibling app tests construct `AppConfig` (spreading `loadConfig()` and overriding fields). If they use a `makeConfig()` helper, use it and set `jobObs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/app-obs-wiring.test.ts`
Expected: FAIL — `workerDeps.obs` is always `undefined`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `apps/backtester/src/app.ts`, add the import:

```ts
import { ObsRegistry } from './jobs/obs-registry.js';
```

Before the `workerDeps` object literal (after `clock` is defined), construct the registry:

```ts
  const obs = config.jobObs ? new ObsRegistry(clock()) : undefined;
```

Add to the `workerDeps` object literal (near `dedupEnabled: config.dedupEnabled,`):

```ts
    ...(obs ? { obs } : {}),
```

**3b.** In `apps/backtester/src/worker-main.ts`, pass the stats provider to the health server. Change the `startWorkerHealthServer` call to include `deps.obs`:

```ts
  const health =
    config.workerHealthPort !== undefined
      ? await startWorkerHealthServer(
          config.workerHealthPort,
          { live: () => !loopDone, ready: () => !draining },
          deps.obs,
        )
      : undefined;
```

(`deps` is `app.workerDeps`, which now carries `obs` when the flag is on. `deps.obs` is `undefined` when off ⇒ `/statsz` 404 — consistent with Task 4.)

**3c.** In `docs/OPERATIONS.md`, add a subsection (place it near the "Result dedup (Phase C item 11)" section):

```markdown
### Job observability (Phase C — dedup enablement)

Set `BACKTESTER_JOB_OBS=true` (default off) to turn on minimal per-job observability. Two channels:

- **Per-job terminal log line** — one JSON line per terminal job on stdout, e.g.
  `{"evt":"job_terminal","runId":"…","engine":"momentum","outcome":"completed","dedup":"hit","queueWaitMs":12,"materializeMs":40,"engineMs":null,"totalMs":55,"ts":…}`.
  `dedup` ∈ `off | evidence_bypass | bypass | hit | miss | stale_recompute`. `engineMs` is `null` only on a `hit`.
  Aggregate with `jq`, e.g. hit-rate: `grep job_terminal | jq -s 'group_by(.dedup)|map({(.[0].dedup):length})'`.
- **`/statsz`** — in-process counters (count/sum/max per phase, counts by outcome and dedup class) since process start,
  served by the worker health server on `WORKER_HEALTH_PORT` (split-worker topology). Not aggregated across replicas
  (the log line is the durable, cross-replica source of truth). Combined `AUTO_WORKER=true` mode has no `/statsz` in this
  release — use the log line.

Queue **depth** is not part of `/statsz`; query it directly:

    SELECT status, count(*) FROM backtest_job GROUP BY status;

`BACKTESTER_JOB_OBS=false` (default) emits nothing and adds no runtime overhead.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/app-obs-wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate**

Run: `pnpm check`
Expected: typecheck clean; all suites green (Docker/Pg-gated suites skip locally).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/src/worker-main.ts docs/OPERATIONS.md apps/backtester/test/app-obs-wiring.test.ts
git commit -m "feat(obs): wire ObsRegistry through buildApp + worker-main; document BACKTESTER_JOB_OBS"
```

---

## Self-Review

**Spec coverage:**
- §1 single instrumentation site + durations → Task 3 (3c–3g). ✅
- §1 determinism guard (clock calls behind flag) → Task 3 (3c/3d/3f gated on `deps.obs`) + test "adds exactly 4 clock calls" + Task 3 Step 5 goldens. ✅
- §2 dedup classification (6 values incl. `evidence_bypass`, `stale_recompute`) → Task 3 (3e) + tests. ✅
- §3 log line → Task 3 (3g); `/statsz` counters (count/sum/max, no percentiles) → Task 1 + Task 4. ✅
- §3 one flag default off → Task 2 + gating in Tasks 3/5. ✅
- §4 `/statsz` worker-health only; combined mode = log line only → Task 4 + Task 5 (3b/docs). ✅
- §5 queue depth via SQL, not instrumented → Task 5 docs. ✅
- Non-goals (no deps/Prometheus/OTel/logger/dashboard/JobStore surface) → honored; bare `console.log`, structural `StatsProvider`. ✅
- Error handling (best-effort emit) → Task 3 (3g try/catch). ✅
- Testing (ObsRegistry unit, classification, durations, flag-off invariant, /statsz shape) → Tasks 1/3/4. ✅

**Placeholder scan:** no TBD/TODO; every code step shows real code. Two guarded fallbacks (engine union, `terminalCode` field) are explicit verify-and-adjust notes, not placeholders. ✅

**Type consistency:** `ObsRegistry`, `JobObsSample`, `DedupClass`, `JobObsSnapshot`, `StatsProvider`, `WorkerDeps.obs`, `AppConfig.jobObs` used identically across Tasks 1→5. ✅
