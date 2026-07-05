import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, runWorkerLoop, type WorkerDeps } from '../src/jobs/worker.js';
import { DOCKER_AVAILABLE, PG_AVAILABLE, createPgSchema } from './store-factories.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store.js';
import type { ModuleBundle } from '@trading/research-contracts';

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

// ─── Docker/PG-gated integration tests ──────────────────────────────────────

function momentumJob(runId: string, seed = 42): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {
      mode: 'research',
      moduleRef: { id: 'smoke', version: '1.0.0' },
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed,
      metrics: [],
    } as never,
    effectiveSeed: seed,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: Date.now(),
  };
}

// Fixed clock matches test/helpers.ts testDeps(): the momentum resultHash is computed from the
// run outcome, which is independent of wall-clock — but we pin the clock anyway so lease/heartbeat
// timing in the loop is the ONLY moving part, never the hashed result.
function buildWorkerDeps(
  store: import('../src/jobs/job-store.js').JobStore,
  workerId: string,
  opts: { ttlMs?: number; clockMs?: number } = {},
): WorkerDeps {
  const config = loadConfig();
  const clockMs = opts.clockMs ?? 1_700_000_000_000;
  return {
    store,
    clock: () => clockMs,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    lease: { workerId, ttlMs: opts.ttlMs ?? 30_000, maxAttempts: 3 },
  } as WorkerDeps;
}

async function submitAndQueueJobs(
  store: import('../src/jobs/job-store.js').JobStore,
  jobs: NewJob[],
): Promise<void> {
  for (const job of jobs) {
    await store.insertOrGet(job);
    await store.transition(job.runId, 'accepted', 'queued', { atMs: Date.now(), queuedAtMs: Date.now() });
  }
}

async function waitAllTerminal(
  store: import('../src/jobs/job-store.js').JobStore,
  runIds: string[],
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await Promise.all(runIds.map((id) => store.get(id)));
    const terminal = ['completed', 'failed', 'canceled', 'expired', 'timed_out'];
    if (rows.every((r) => r && terminal.includes(r.status))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for jobs to reach terminal state');
}

describe.skipIf(!PG_AVAILABLE)('worker-loop integration [postgres]', () => {
  it('determinism: two concurrent runWorkerLoop instances produce same per-job resultHash as single-worker drain', async () => {
    // The momentum resultHash bakes in the job's runId (BacktestResult.runId === request.runId,
    // and resultHash = contentRef(result)). So a valid serial-vs-parallel comparison MUST drain the
    // SAME runIds in both passes — only the worker scheduling differs. We use one shared set of
    // runIds (`seed-N`) on two independent PG schemas, mirroring worker-concurrency.test.ts.
    const N = 4;
    const runIds = Array.from({ length: N }, (_, i) => `seed-${i}`);
    const { makeStore: makeRef, teardown: teardownRef } = await createPgSchema();
    const { makeStore: makeTw, teardown: teardownTw } = await createPgSchema();

    try {
      // ── reference: single worker drains the canonical run set ──
      const refStore = makeRef();
      await submitAndQueueJobs(refStore, runIds.map((id, i) => momentumJob(id, i)));

      const refAc = new AbortController();
      const refLoop = runWorkerLoop(buildWorkerDeps(refStore, 'ref-worker'), {
        concurrency: 1, heartbeatMs: 5_000, pollMs: 100, signal: refAc.signal,
      });
      await waitAllTerminal(refStore, runIds);
      refAc.abort();
      await refLoop;

      const refHashes = new Map<string, string>();
      for (const id of runIds) {
        const row = await refStore.get(id);
        expect(row?.status).toBe('completed');
        refHashes.set(id, String(row!.resultHash));
      }

      // ── test: TWO concurrent workers drain the SAME run set on a fresh schema ──
      const twStore = makeTw();
      await submitAndQueueJobs(twStore, runIds.map((id, i) => momentumJob(id, i)));

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const loop1 = runWorkerLoop(buildWorkerDeps(twStore, 'w1'), {
        concurrency: 2, heartbeatMs: 5_000, pollMs: 100, signal: ac1.signal,
      });
      const loop2 = runWorkerLoop(buildWorkerDeps(twStore, 'w2'), {
        concurrency: 2, heartbeatMs: 5_000, pollMs: 100, signal: ac2.signal,
      });
      await waitAllTerminal(twStore, runIds);
      ac1.abort();
      ac2.abort();
      await Promise.all([loop1, loop2]);

      // Per-job equality: the SAME runId yields the SAME resultHash regardless of which worker ran it.
      for (const id of runIds) {
        const row = await twStore.get(id);
        expect(row?.status).toBe('completed');
        expect(row!.resultHash).toBe(refHashes.get(id));
      }
    } finally {
      await teardownRef();
      await teardownTw();
    }
  }, 120_000);

  it('crash recovery: orphaned lease is requeued by reaper and completed by second worker', async () => {
    // Crash simulation (STORE-LEVEL, per the brief's allowance): wA acquires the lease by calling
    // store.claimNextQueued directly with a SHORT ttl (800ms) and then "crashes" — it never heartbeats
    // (no renewLease) and never completes the run. After the lease expires, wB runs runWorkerLoop,
    // whose per-pass reapAndPublish() requeues the orphaned (now lease-expired) row; wB then claims and
    // completes it. We assert the recovered resultHash equals the hash a CLEAN single-worker drain of
    // the same runId produces (computing the expected value, not pinning a brittle literal).
    const { makeStore: makeRef, teardown: teardownRef } = await createPgSchema();
    const { makeStore: makeCrash, teardown: teardownCrash } = await createPgSchema();
    try {
      // ── expected: clean single-worker drain of the same runId ──
      const refStore = makeRef();
      await submitAndQueueJobs(refStore, [momentumJob('crash-job', 42)]);
      const refAc = new AbortController();
      const refLoop = runWorkerLoop(buildWorkerDeps(refStore, 'ref'), {
        concurrency: 1, heartbeatMs: 5_000, pollMs: 100, signal: refAc.signal,
      });
      await waitAllTerminal(refStore, ['crash-job']);
      refAc.abort();
      await refLoop;
      const expectedHash = String((await refStore.get('crash-job'))!.resultHash);

      // ── crash + recovery ──
      // wA claims at T0 with an 800ms lease (lease_expires_at = T0 + 800). wB then runs with a clock
      // pinned PAST that expiry so the reaper's `now > lease_expires_at` predicate fires and requeues
      // the orphan. The resultHash is clock-independent (it hashes the run outcome), so advancing wB's
      // clock cannot move the golden.
      const T0 = 1_700_000_000_000;
      const store = makeCrash();
      await submitAndQueueJobs(store, [momentumJob('crash-job', 42)]);

      // wA claims with a short lease then "crashes" (never renews, never completes).
      const claimedByA = await store.claimNextQueued(T0, { workerId: 'wA', ttlMs: 800 });
      expect(claimedByA).toBeTruthy();
      expect(claimedByA!.leasedBy).toBe('wA');
      expect((await store.get('crash-job'))!.status).toBe('running');

      // wB's loop runs at a clock past wA's lease expiry: reapAndPublish() requeues the orphan,
      // then wB drains and completes it.
      const acB = new AbortController();
      const loopB = runWorkerLoop(buildWorkerDeps(store, 'wB', { clockMs: T0 + 5_000 }), {
        concurrency: 1, heartbeatMs: 5_000, pollMs: 100, signal: acB.signal,
      });
      await waitAllTerminal(store, ['crash-job'], 30_000);
      acB.abort();
      await loopB;

      const row = await store.get('crash-job');
      expect(row?.status).toBe('completed');
      expect(row?.leasedBy).toBe('wB'); // recovered by the second worker, not wA
      expect(row?.attempts).toBeGreaterThanOrEqual(2); // wA's failed attempt + wB's successful one
      expect(row?.resultHash).toBe(expectedHash); // recovery reproduces the clean-drain result
    } finally {
      await teardownRef();
      await teardownCrash();
    }
  }, 60_000);
});

// ─── Strategy-engine dispatch (cheap, no Docker) ────────────────────────────

describe('strategy-engine dispatch', () => {
  it('strategy job without bundleHash is rejected with validation_error', async () => {
    const store = new InMemoryJobStore();
    const runId = 'strategy-no-bundle-test';
    const job: NewJob = {
      jobId: runId,
      runId,
      requestFingerprint: `fp-${runId}`,
      request: {
        mode: 'research',
        moduleRef: { id: 'my-strategy', version: '1.0.0' },
        datasetRef: 'smoke-btc-1m',
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
        seed: 42,
        metrics: [],
        engine: 'strategy',
      } as never,
      effectiveSeed: 42,
      datasetRef: 'smoke-btc-1m',
      // NO bundleHash — the strategy branch must reject this immediately
      runTimeoutMs: 3_600_000,
      acceptedAtMs: 1_700_000_000_000,
    };

    await store.insertOrGet(job);
    await store.transition(runId, 'accepted', 'queued', {
      atMs: 1_700_000_000_000,
      queuedAtMs: 1_700_000_000_000,
    });

    const deps = {
      store,
      clock: () => 1_700_000_000_000,
      uid: () => randomUUID(),
      postWebhook: async () => {},
      dataPort: {} as never,
      artifactStore: {} as never,
      overlaySandbox: {} as never,
    } as unknown as WorkerDeps;

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('validation_error');
  });

  it('strategy job with bundle present but moduleRef != bundle manifest is rejected with validation_error', async () => {
    // Load the fixture bundle: kind:'strategy', id:'short_after_pump', version:'0.1.0'
    const bundle = JSON.parse(
      readFileSync(
        new URL('./fixtures/overlay/bundles/short-after-pump.bundle.json', import.meta.url),
        'utf8',
      ),
    ) as ModuleBundle;
    const bundleStore = new InMemoryBundleStore();
    const hash = await bundleStore.put(bundle);

    const store = new InMemoryJobStore();
    const runId = 'strategy-mismatched-moduleref';
    const job: NewJob = {
      jobId: runId,
      runId,
      requestFingerprint: `fp-${runId}`,
      request: {
        mode: 'research',
        // Intentionally different from bundle manifest (short_after_pump@0.1.0):
        moduleRef: { id: 'trusted-strategy-DIFFERENT', version: '9.9.9' },
        datasetRef: 'smoke-btc-1m',
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
        seed: 42,
        metrics: [],
        engine: 'strategy',
      } as never,
      effectiveSeed: 42,
      datasetRef: 'smoke-btc-1m',
      bundleHash: hash,
      runTimeoutMs: 3_600_000,
      acceptedAtMs: 1_700_000_000_000,
    };

    await store.insertOrGet(job);
    await store.transition(runId, 'accepted', 'queued', {
      atMs: 1_700_000_000_000,
      queuedAtMs: 1_700_000_000_000,
    });

    const config = loadConfig();
    const deps = {
      store,
      clock: () => 1_700_000_000_000,
      uid: () => randomUUID(),
      postWebhook: async () => {},
      dataPort: {} as never,
      artifactStore: {} as never,
      overlaySandbox: config.overlaySandbox,
      bundleStore,
    } as unknown as WorkerDeps;

    // Guard fires before marketTape/sandbox allocation — pure fs, no Docker needed.
    // terminalCode='validation_error' proves the moduleRef-vs-manifest guard was reached
    // (both earlier guards pass: bundleHash is set + manifest.kind==='strategy').
    const row = await processNextQueued(deps);
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('validation_error');
  });
});

describe.skipIf(!DOCKER_AVAILABLE || !PG_AVAILABLE)('worker-loop docker+pg integration', () => {
  it('placeholder: docker+pg combined gate (covered by the pg suite above when pg is available)', () => {
    expect(true).toBe(true);
  });
});
