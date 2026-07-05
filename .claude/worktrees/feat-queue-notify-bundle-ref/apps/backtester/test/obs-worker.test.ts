// Task 3 (job-obs) — instrument processNextQueued: per-job timing + dedup classification + best-effort emit.
//
// Mirrors dedup-worker.test.ts's momentum harness (makeCtx/momentumJob/enqueue), extended to wire an
// ObsRegistry into deps. Docker-free (momentum path only). Asserts:
//  - a fresh (miss) momentum run records a full duration breakdown and emits exactly one job_terminal line
//  - an identical second run classifies as a dedup hit with engineMs null (engine skipped)
//  - obs OFF (deps.obs absent) emits no log line and does not change job outcome
//  - obs ON adds EXACTLY 4 extra deps.clock() calls vs obs OFF on a momentum miss (determinism guard)

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';

const CLOCK = 1_700_000_000_000;
// Two identical requests differ ONLY by runId ⇒ they share a runId-independent requestFingerprint.
const SHARED_FP = 'fp-momentum-obs-shared';

const REQ = {
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
} as const;

function momentumJob(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: SHARED_FP,
    request: REQ as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

interface Ctx {
  store: InMemoryJobStore;
  cache: InMemoryResultCache;
  deps: WorkerDeps;
}

function makeCtx(opts: { dedupEnabled?: boolean; obs?: ObsRegistry } = {}): Ctx {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const cache = new InMemoryResultCache();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: cache,
    ...(opts.dedupEnabled !== undefined ? { dedupEnabled: opts.dedupEnabled } : {}),
    ...(opts.obs ? { obs: opts.obs } : {}),
  } as WorkerDeps;
  return { store, cache, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

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
