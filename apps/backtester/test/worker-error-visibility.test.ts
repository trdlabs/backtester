// Task 5 (job-error-visibility) — unconditional job_error console.error line + errorDetail carried
// into job_terminal. Mirrors obs-worker.test.ts's momentum harness (makeCtx/momentumJob/enqueue)
// verbatim, swapping FixtureDataPort for a throwing dataPort to drive processNextQueued's catch.
//
// Asserts:
//  - obs OFF: processNextQueued still emits exactly one console.error job_error line, unconditionally,
//    with the SAME bounded/normalized detail boundedErrorDetail would produce (Task 1).
//  - obs ON: the job_terminal line gains errorDetail === the same bounded string.
//  - obs ON + a successful (non-throwing) run: job_terminal carries no errorDetail key at all.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { ObsRegistry } from '../src/jobs/obs-registry.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort, type BacktesterDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';

const CLOCK = 1_700_000_000_000;
// Normalization (boundedErrorDetail): '\n' → ' ' (control-char class), whitespace collapsed, then
// slice(0, 300). 400 X's already exceeds 300, so the slice cuts BEFORE ' second line' ever matters —
// the bounded detail is exactly 300 X's, nothing else.
const LONG_MESSAGE = `${'X'.repeat(400)}\nsecond line`;
const EXPECTED_DETAIL = 'X'.repeat(300);

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

// A dataPort whose openDataset always throws a plain (non-RunnerError) Error with a long, newline-
// carrying message — drives processNextQueued's catch with code === 'runner_failure' and exercises
// boundedErrorDetail's normalization + truncation.
const throwingDataPort: BacktesterDataPort = {
  listDatasets: async () => [],
  openDataset: async () => {
    throw new Error(LONG_MESSAGE);
  },
};

interface Ctx {
  store: InMemoryJobStore;
  deps: WorkerDeps;
}

function makeCtx(opts: { obs?: ObsRegistry; failing?: boolean } = {}): Ctx {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: opts.failing ? throwingDataPort : new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: new InMemoryResultCache(),
    ...(opts.obs ? { obs: opts.obs } : {}),
  } as WorkerDeps;
  return { store, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

afterEach(() => vi.restoreAllMocks());

describe('worker error visibility — job_error + errorDetail', () => {
  it('obs OFF: emits an unconditional bounded job_error line on console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, deps } = makeCtx({ failing: true });
    await enqueue(store, 'run-err-1');
    await processNextQueued(deps);

    const errorLines = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_error"'));
    expect(errorLines).toHaveLength(1);

    const parsed = JSON.parse(errorLines[0]);
    expect(parsed).toMatchObject({ evt: 'job_error', runId: 'run-err-1', code: 'runner_failure', detail: EXPECTED_DETAIL });
    expect(parsed.detail).toHaveLength(300);
    // eslint-disable-next-line no-control-regex
    expect(/[\n\r\u0000-\u001f\u007f]/.test(parsed.detail)).toBe(false);
  });

  it('obs ON: job_terminal carries the same bounded errorDetail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const obs = new ObsRegistry(0);
    const { store, deps } = makeCtx({ obs, failing: true });
    await enqueue(store, 'run-err-2');
    await processNextQueued(deps);

    const terminalLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_terminal"'));
    expect(terminalLines).toHaveLength(1);

    const sample = JSON.parse(terminalLines[0]);
    expect(sample.outcome).toBe('failed');
    expect(sample.errorDetail).toBe(EXPECTED_DETAIL);
  });

  it('obs ON + successful run: job_terminal carries no errorDetail key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const obs = new ObsRegistry(0);
    const { store, deps } = makeCtx({ obs });
    await enqueue(store, 'run-ok-1');
    await processNextQueued(deps);

    const terminalLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('"evt":"job_terminal"'));
    expect(terminalLines).toHaveLength(1);

    const sample = JSON.parse(terminalLines[0]);
    expect(sample.outcome).toBe('completed');
    expect('errorDetail' in sample).toBe(false);
  });
});
