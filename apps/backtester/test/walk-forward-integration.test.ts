// E3b Task 7 — worker-level durability + isolation for walk-forward execution.
//
// Drives ONE overlay run through the real worker loop (processNextQueued/drainQueue) with
// deps.walkForward = { enabled: true, maxFolds: 20 } and request.walkForward = { folds: 2, mode:
// 'rolling' }, injecting a canned per-fold runner via
// `vi.spyOn(workerInternals, 'makeWalkForwardRunFold').mockReturnValue(...)` so the fold loop never
// touches Docker/the sandbox. The OUTER canonical engine call (`runOverlayBacktest`) is also mocked to
// return a fixed CompletedOutcome so the trial-ledger / novelty-pool assertions below are deterministic
// (independent of the fixture's real trade/equity shape) — bundleHash stays undefined throughout, so
// nothing in this run ever needs a sandbox container.
//
// Asserts:
//   - durability: the terminal row's `resultSummary.walkForward` is present after drainQueue, on BOTH
//     InMemoryJobStore and PgJobStore (Pg gated behind DATABASE_URL / BACKTESTER_TEST_DATABASE_URL via
//     the repo's shared PG_AVAILABLE probe — proves the WalkForward union round-trips through jsonb).
//   - isolation: the fold loop calls the canonical E2 trial-ledger's `recordIfNew` and the E5a
//     novelty-pool's `recordIfNew` NEITHER MORE NOR FEWER than the ONE canonical (non-fold) finalize
//     call does — i.e. exactly once for the whole run, not once per fold (2 folds configured) — and the
//     webhook poster fires exactly once for the run, not once per fold.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainQueue, workerInternals, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryTrialLedger } from '../src/jobs/ledger/trial-ledger.js';
import { InMemoryNoveltyPool } from '../src/jobs/ledger/novelty-pool.js';
import * as runOverlayModule from '../src/engine/run-overlay.js';
import { PG_AVAILABLE, createPgSchema } from './store-factories.js';
import type { RunFold } from '../src/engine/walk-forward-exec.js';

const CLOCK = 1_700_000_000_000;
const DAY = 86_400_000;

// baseline.json's overlay/momentum fixture wiring (dedup-equivalence.test.ts / dedup-worker.test.ts):
// moduleRef short_after_pump@0.1.0 over pump-fixture-1m, resolved via buildTrustedRegistry() — NO
// bundleHash, so materializeFor's real buildOverlayDataset call succeeds without Docker.
//
// wfo-extended-fixture item 4 added an up-front (pre-fold) history check: at the '1m' cadence with
// maxFolds:20, requiredWalkForwardDays ⇒ 1 day (ceil((20+1)*34 warmup bars / 1440 min-per-day)). The
// PUMP FIXTURE itself only has 30 real minutes of rows, but materializeFor's tape build tolerates a
// period wider than the fixture's actual coverage (this run's canonical engine call AND every fold are
// both mocked below, so no code path here actually needs real bars past minute 30) — widen the
// REQUESTED period to 2 days purely so it clears the up-front floor; the mocked outcomes are unchanged.
const REQ = {
  mode: 'research',
  engine: 'overlay',
  moduleRef: { id: 'short_after_pump', version: '0.1.0' },
  datasetRef: 'pump-fixture-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2025-01-01T00:00:00Z', to: '2025-01-03T00:00:00Z' },
  riskProfileRef: { id: 'default_risk', version: '1.0.0' },
  executionProfileRef: { id: 'default_exec', version: '1.0.0' },
  seed: 12345,
  metrics: ['pnl', 'max_drawdown', 'win_rate', 'sharpe'],
  walkForward: { folds: 2, mode: 'rolling' },
} as const;

// Day-spaced equity: satisfies BOTH E2's DSR (>=2 non-degenerate returns) and E5a's novelty candidate
// (>=2 daily deltas across UTC day boundaries) — the exact "sharpe 1/3" series from record-trial.test.ts,
// re-spaced to one point per day so toDailyPnlDeltas doesn't collapse it into a single day.
function equityCurve(vals: readonly number[]) {
  return vals.map((equity, i) => ({ barIndex: i, barTs: i * DAY, equity }));
}
const EQUITY = equityCurve([100, 120, 108, 129.6]);

// Minimal-but-runtime-complete CompletedOutcome: only the fields finalizeResult/persistOverlayArtifacts
// /toOverlaySummary/resolveNovelty/recordTrialAndComputeContext actually read at runtime.
function cannedOutcome(runId: string) {
  return {
    status: 'completed',
    baseline: {
      runId,
      metrics: { pnl: 10 },
      trades: [],
      decisionRecords: [],
      evidence: {
        seed: 12345,
        contractVersion: '1.0.0',
        moduleVersions: [{ id: 'short_after_pump', version: '0.1.0' }],
        datasetRef: 'pump-fixture-1m',
        equityCurve: EQUITY,
      },
    },
    variant: null,
    comparison: null,
  } as any;
}

function foldOutcome() {
  return {
    status: 'completed',
    baseline: { trades: [], evidence: { equityCurve: EQUITY } },
  } as any;
}
// The injected fold runner: NEVER touches deps.trialLedger / deps.novelty.pool / deps.postWebhook —
// that is exactly the isolation property under test (a regression that threaded finalize-like logic
// into the per-fold path would inflate the recordIfNew counts asserted below).
const cannedRunFold: RunFold = async (fold) => ({ outcome: foldOutcome(), hash: `h${fold.index}` });

function overlayJob(runId: string, requestFingerprint: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint,
    request: REQ as never,
    effectiveSeed: REQ.seed,
    datasetRef: REQ.datasetRef,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
    callbackUrl: 'https://example.test/webhook',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('walk-forward — durability (InMemoryJobStore)', () => {
  it('resultSummary.walkForward is present on the terminal row after drainQueue', async () => {
    const config = loadConfig();
    const store = new InMemoryJobStore();
    const ledger = new InMemoryTrialLedger();
    const pool = new InMemoryNoveltyPool();
    const postWebhook = vi.fn(async () => {});
    const ledgerSpy = vi.spyOn(ledger, 'recordIfNew');
    const poolSpy = vi.spyOn(pool, 'recordIfNew');

    const deps: WorkerDeps = {
      store,
      clock: () => CLOCK,
      uid: () => randomUUID(),
      postWebhook,
      dataPort: new FixtureDataPort(FIXTURES_DIR),
      artifactStore: new InMemoryArtifactStore(),
      overlaySandbox: config.overlaySandbox,
      walkForward: { enabled: true, maxFolds: 20 },
      trialLedger: ledger,
      trialLedgerEnabled: true,
      novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool },
    } as WorkerDeps;

    const runId = 'run-wf-inmem';
    await store.insertOrGet(overlayJob(runId, 'fp-wf-inmem'));
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const runFoldSpy = vi.spyOn(workerInternals, 'makeWalkForwardRunFold').mockReturnValue(cannedRunFold);
    vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValue(cannedOutcome(runId));

    await drainQueue(deps, 1);

    const row = await store.get(runId);
    expect(row?.status).toBe('completed');
    expect(row?.resultSummary?.walkForward).toBeDefined();
    expect((row?.resultSummary?.walkForward as { scheme: unknown })?.scheme).toEqual({ folds: 2, mode: 'rolling' });

    // The factory seam is invoked exactly once per run (it returns a RunFold the pure orchestrator then
    // calls once per fold internally) — proves resolveWalkForward actually engaged.
    expect(runFoldSpy).toHaveBeenCalledTimes(1);

    // Isolation: 2 folds ran (via the canned runFold) but recordIfNew fired exactly once each — the ONE
    // canonical (non-fold) finalize call, not 1-per-fold (which would read 3, not 1).
    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(poolSpy).toHaveBeenCalledTimes(1);
    // Webhook fired exactly once for the whole run, not once per fold.
    expect(postWebhook).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!PG_AVAILABLE)('walk-forward — durability (PgJobStore, jsonb round-trip)', () => {
  it('resultSummary.walkForward survives a jsonb write + read round-trip', async () => {
    const { makeStore, teardown } = await createPgSchema();
    try {
      const store = makeStore();
      const config = loadConfig();
      const ledger = new InMemoryTrialLedger();
      const pool = new InMemoryNoveltyPool();
      const deps: WorkerDeps = {
        store,
        clock: () => CLOCK,
        uid: () => randomUUID(),
        postWebhook: async () => {},
        dataPort: new FixtureDataPort(FIXTURES_DIR),
        artifactStore: new InMemoryArtifactStore(),
        overlaySandbox: config.overlaySandbox,
        walkForward: { enabled: true, maxFolds: 20 },
        trialLedger: ledger,
        trialLedgerEnabled: true,
        novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool },
      } as WorkerDeps;

      const runId = 'run-wf-pg';
      await store.insertOrGet(overlayJob(runId, 'fp-wf-pg'));
      await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

      vi.spyOn(workerInternals, 'makeWalkForwardRunFold').mockReturnValue(cannedRunFold);
      vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValue(cannedOutcome(runId));

      await drainQueue(deps, 1);

      const row = await store.get(runId);
      expect(row?.status).toBe('completed');
      expect(row?.resultSummary?.walkForward).toBeDefined();
      expect((row?.resultSummary?.walkForward as { scheme: unknown })?.scheme).toEqual({ folds: 2, mode: 'rolling' });
    } finally {
      await teardown();
    }
  });
});
