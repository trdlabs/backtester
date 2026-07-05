// Task 4 (phase-a-real-platform-finish) — worker maps RealDataUnavailableError (Task 3) to the
// existing `missing_dataset` terminal code, with errorDetail equal to the error's fixed
// `cause=<reason>; datasetRef=<ref>` string. Mirrors worker-error-visibility.test.ts's harness
// verbatim (InMemoryJobStore, makeCtx/enqueue, momentumJob request shape), swapping in a
// dataPort whose openDataset throws RealDataUnavailableError instead of a plain Error.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { type BacktesterDataPort } from '../src/data/reader.js';
import { RealDataUnavailableError } from '../src/data/rows-data-port.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';

const CLOCK = 1_700_000_000_000;

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
    requestFingerprint: `fp-${runId}`,
    request: REQ as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

// Same request shape, routed through the OVERLAY engine (materializeFor's overlay branch calls
// buildOverlayDataset -> dataPort.openDataset — the actual production real-platform call site).
// No bundleHash/moduleBundle needed: the strategy-only pre-flight guard doesn't apply to 'overlay',
// and buildOverlayDataset throws before any registry/sandbox work, so the failure is identical.
const REQ_OVERLAY = { ...REQ, engine: 'overlay' } as const;

function overlayJob(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: REQ_OVERLAY as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

// A dataPort whose openDataset always throws the normalized platform-failure error (Task 3),
// with a fixed cause + datasetRef — drives processNextQueued's catch and asserts the
// missing_dataset terminal-code mapping (Task 4).
const realDataUnavailableDataPort: BacktesterDataPort = {
  listDatasets: async () => [],
  openDataset: async () => {
    throw new RealDataUnavailableError('unauthorized', 'BTCUSDT:1m');
  },
};

interface Ctx {
  store: InMemoryJobStore;
  deps: WorkerDeps;
}

function makeCtx(): Ctx {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: realDataUnavailableDataPort,
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: new InMemoryResultCache(),
  } as WorkerDeps;
  return { store, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

async function enqueueOverlay(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(overlayJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

afterEach(() => vi.restoreAllMocks());

describe('worker maps RealDataUnavailableError', () => {
  it('terminates missing_dataset with the fixed cause detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = makeCtx();
    await enqueue(store, 'run-real-data-1');
    await processNextQueued(deps);

    const finished = await store.get('run-real-data-1');
    expect(finished?.status).toBe('failed');
    expect(finished?.terminalCode).toBe('missing_dataset');

    // errorDetail is not projected onto the terminal row today (see worker-error-visibility.test.ts) —
    // assert it via the job_error console line the same way that test does.
    const errSpy = vi.mocked(console.error);
    const errorLines = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_error"'));
    expect(errorLines).toHaveLength(1);
    const parsed = JSON.parse(errorLines[0]);
    expect(parsed.code).toBe('missing_dataset');
    expect(parsed.detail).toBe('cause=unauthorized; datasetRef=BTCUSDT:1m');
  });

  it('terminates missing_dataset with the fixed cause detail on the OVERLAY engine path', async () => {
    // Drives materializeFor's overlay branch (buildOverlayDataset -> dataPort.openDataset), the
    // real-platform call site for overlay/strategy runs — distinct from the momentum path above.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = makeCtx();
    await enqueueOverlay(store, 'run-real-data-overlay-1');
    await processNextQueued(deps);

    const finished = await store.get('run-real-data-overlay-1');
    expect(finished?.status).toBe('failed');
    expect(finished?.terminalCode).toBe('missing_dataset');

    const errSpy = vi.mocked(console.error);
    const errorLines = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_error"'));
    expect(errorLines).toHaveLength(1);
    const parsed = JSON.parse(errorLines[0]);
    expect(parsed.code).toBe('missing_dataset');
    expect(parsed.detail).toBe('cause=unauthorized; datasetRef=BTCUSDT:1m');
  });
});
