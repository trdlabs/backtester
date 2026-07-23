// research-validation-hardening R1(4) — resultHash invariant. `finalizeResult` computes
// `resultHash = contentRef(payload)` (worker.ts) BEFORE any advisory block runs (trialContext/holdout/
// diagnostics/novelty/promotion) — trialContext is stateful (depends on ledger history) and therefore
// can never be part of the hashed payload. This pins that ordering on the REAL finalize path: the same
// run, with the E2 trial ledger flag ON vs OFF, must produce a BYTE-IDENTICAL result_hash. Pattern
// follows walk-forward-integration.test.ts (drainQueue with a mocked outer engine call).

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
const RUN_ID = 'run-hash-invariant';
const REQUEST_FINGERPRINT = 'fp-hash-invariant';

const REQ = {
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
  trialFamilyHint: 'hash-invariant-experiment',
} as const;

function equityCurve(vals: readonly number[]) {
  return vals.map((equity, i) => ({ barIndex: i, barTs: i * DAY, equity }));
}
const EQUITY = equityCurve([100, 120, 108, 129.6]);

// SAME outcome content for both ON/OFF drains — only the deps.trialLedger(Enabled) wiring differs.
function cannedOutcome() {
  return {
    status: 'completed',
    baseline: {
      runId: RUN_ID,
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

function job(): NewJob {
  return {
    jobId: RUN_ID,
    runId: RUN_ID,
    requestFingerprint: REQUEST_FINGERPRINT,
    request: REQ as never,
    effectiveSeed: REQ.seed,
    datasetRef: REQ.datasetRef,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

async function runOnce(deps: Partial<WorkerDeps>): Promise<{ resultHash: unknown; trialContext: unknown }> {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const fullDeps: WorkerDeps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    ...deps,
  } as WorkerDeps;

  vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValueOnce(cannedOutcome());
  await store.insertOrGet(job());
  await store.transition(RUN_ID, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
  await drainQueue(fullDeps, 1);

  const row = await store.get(RUN_ID);
  expect(row?.status).toBe('completed');
  return { resultHash: row?.resultSummary?.resultHash, trialContext: row?.resultSummary?.trialContext };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resultHash invariant — E2 trial ledger flag ON vs OFF (research-validation-hardening R1.4)', () => {
  it('is byte-identical on the SAME run whether the trial ledger is enabled or not', async () => {
    const off = await runOnce({}); // trialLedger/trialLedgerEnabled both absent ⇒ advisory block never runs
    const on = await runOnce({ trialLedger: new InMemoryTrialLedger(), trialLedgerEnabled: true });

    expect(off.resultHash).toBeDefined();
    expect(on.resultHash).toBe(off.resultHash); // the invariant under test

    // Sanity: the flags actually differed in effect (otherwise the invariant would be vacuous).
    expect(off.trialContext).toBeUndefined();
    expect(on.trialContext).toBeDefined();
  });
});
