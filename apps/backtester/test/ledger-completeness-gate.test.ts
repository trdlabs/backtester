// research-validation-hardening R1(c) — "Ledger-completeness" gate (canonical validation gate on the
// control-center card): an N-point grid experiment (one hypothesis, N parameter trials — same
// trialFamilyHint/datasetRef/symbols/timeframe/period, only the strategy params differ across grid
// points) must produce EXACTLY N ledger rows under ONE familyKey, with a monotonic trialCount, and
// every completed run's summary.trialContext populated (familyKey, trialCount, deflatedSharpe).
//
// Pattern follows walk-forward-integration.test.ts: drives each grid point through the REAL finalize
// path (drainQueue → processNextQueued → finalizeResult), only mocking the outer engine call
// (`runOverlayBacktest`) so the test is deterministic and never touches Docker/the sandbox.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainQueue, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryTrialLedger } from '../src/jobs/ledger/trial-ledger.js';
import * as runOverlayModule from '../src/engine/run-overlay.js';

const CLOCK = 1_700_000_000_000;
const DAY = 86_400_000;

// Shared family context (mirrors baseline.json's overlay fixture wiring, per walk-forward-integration.test.ts):
// moduleRef short_after_pump@0.1.0 over pump-fixture-1m — NO bundleHash, so materializeFor's real
// buildOverlayDataset call succeeds without Docker. ONE trialFamilyHint ⇒ ONE experiment/family.
const FAMILY = {
  mode: 'research',
  engine: 'overlay',
  moduleRef: { id: 'short_after_pump', version: '0.1.0' },
  datasetRef: 'pump-fixture-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2025-01-01T00:00:00Z', to: '2025-01-01T00:30:00Z' },
  riskProfileRef: { id: 'default_risk', version: '1.0.0' },
  executionProfileRef: { id: 'default_exec', version: '1.0.0' },
  seed: 12345,
  metrics: ['pnl', 'max_drawdown', 'win_rate', 'sharpe'],
  trialFamilyHint: 'oi-divergence-grid-sweep',
} as const;

function equityCurve(vals: readonly number[]) {
  return vals.map((equity, i) => ({ barIndex: i, barTs: i * DAY, equity }));
}
// Distinct-but-all-valid equity curves (>=2 non-degenerate daily returns) — one per "grid point"
// (different strategy params would have produced these; params themselves aren't in FamilyKeyInput).
const GRID_EQUITY = [
  equityCurve([100, 120, 108, 129.6]),
  equityCurve([100, 110, 121, 108.9]),
  equityCurve([100, 105, 99.75, 104.7375]),
  equityCurve([100, 130, 117, 128.7]),
];

function cannedOutcome(runId: string, equity: ReturnType<typeof equityCurve>) {
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
        equityCurve: equity,
      },
    },
    variant: null,
    comparison: null,
  } as any;
}

function gridJob(runId: string, requestFingerprint: string, paramsOver: Record<string, unknown>): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint,
    request: { ...FAMILY, params: paramsOver } as never,
    effectiveSeed: FAMILY.seed,
    datasetRef: FAMILY.datasetRef,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ledger-completeness gate (research-validation-hardening R1c)', () => {
  it('an N-point grid experiment produces exactly N ledger rows under one familyKey, trialCount monotonic, every summary.trialContext populated', async () => {
    const config = loadConfig();
    const store = new InMemoryJobStore();
    const ledger = new InMemoryTrialLedger();
    const N = GRID_EQUITY.length;

    const deps: WorkerDeps = {
      store,
      clock: () => CLOCK,
      uid: () => randomUUID(),
      postWebhook: async () => {},
      dataPort: new FixtureDataPort(FIXTURES_DIR),
      artifactStore: new InMemoryArtifactStore(),
      overlaySandbox: config.overlaySandbox,
      trialLedger: ledger,
      trialLedgerEnabled: true,
    } as WorkerDeps;

    let familyKey: string | undefined;
    for (let i = 1; i <= N; i += 1) {
      const runId = `run-grid-${i}`;
      vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValueOnce(
        cannedOutcome(runId, GRID_EQUITY[i - 1]),
      );
      await store.insertOrGet(gridJob(runId, `fp-grid-${i}`, { threshold: i }));
      await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

      await drainQueue(deps, 1);

      const row = await store.get(runId);
      expect(row?.status).toBe('completed');
      const trialContext = row?.resultSummary?.trialContext;
      expect(trialContext).toBeDefined();
      expect(typeof trialContext!.familyKey).toBe('string');
      expect(trialContext!.familyKey.length).toBeGreaterThan(0);
      expect(trialContext!.trialCount).toBe(i); // monotonic 1..N across the whole experiment
      expect(Number.isFinite(trialContext!.deflatedSharpe)).toBe(true);
      if (familyKey !== undefined) expect(trialContext!.familyKey).toBe(familyKey); // one family throughout
      familyKey = trialContext!.familyKey;
    }

    // Ledger-completeness: exactly N rows recorded under the one family (no more, no fewer).
    const rows = await ledger.query(familyKey!);
    expect(rows.length).toBe(N);
  });
});
