// Task 7 — TDD gate: produceStrategyEvidence (abort-before-sign).
//
// 3 cases:
//   (a) equivalent runs + accepted bundle + passed verdict → signed artifact verifies
//   (b) divergent runs → throws (no artifact emitted)
//   (c) rejected bundle → throws BEFORE signing
//
// Pure-ish: no Docker — materializeBundle is fs-only. RunOutcomes are injected fabrications.
// Dev run from monorepo root: pnpm exec vitest run apps/backtester/test/produce-strategy-evidence.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunOutcome, Trade, EquityPoint } from '../src/engine/artifacts.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle, type ModuleBundle } from '../src/engine/sandbox/bundle.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { generateSigningKey, verifySignedEvidenceLocal } from '../src/evidence/signing.js';
import { produceStrategyEvidence } from '../src/evidence/produce-strategy-evidence.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLES_DIR = join(HERE, 'fixtures/overlay/bundles');

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(
    readFileSync(join(BUNDLES_DIR, `${name}.bundle.json`), 'utf8'),
  ) as InlineModuleBundle;
}

// ── fabricated RunOutcomes ────────────────────────────────────────────────────
// Equity curve: monotone rise → sharpe > 0, drawdown = 0 < 1, winRate > 0 (via winning trade).
// Sufficient for DEFAULT_THRESHOLDS (minSharpe:0, maxDrawdown:1, minWinRate:0, minTrades:1).

const EQUITY: readonly EquityPoint[] = [
  { barIndex: 0, barTs: 0, equity: 10_000 },
  { barIndex: 1, barTs: 60_000, equity: 10_100 },
  { barIndex: 2, barTs: 120_000, equity: 10_200 },
];

function makeTrade(exitBarIndex: number, exitFillPrice: number, realizedPnl: number): Trade {
  return {
    id: `trade-${exitBarIndex}`,
    symbol: 'BTCUSDT',
    side: 'long',
    entryBarIndex: 0,
    entryTs: 0,
    entryFillPrice: 100,
    exitBarIndex,
    exitTs: exitBarIndex * 60_000,
    exitFillPrice,
    size: 1,
    feePaid: 0,
    realizedPnl,
    closeReason: 'end_of_data',
  };
}

const WINNING_TRADE = makeTrade(1, 101, 1);

const REF = { id: 'default', version: '1.0.0' };

let _runSeq = 0;
function makeRunOutcome(
  trades: readonly Trade[],
  runId?: string,
  equity: readonly EquityPoint[] = EQUITY,
): RunOutcome {
  _runSeq += 1;
  return {
    status: 'completed',
    baseline: {
      runId: runId ?? `run-${_runSeq}`,
      summary: {
        targetKind: 'baseline',
        moduleRef: REF,
        overlayRefs: [],
        symbols: ['BTCUSDT'],
        barsProcessed: 3,
        ordersCount: trades.length,
        closedTradesCount: trades.length,
      },
      metrics: {},
      trades,
      decisionRecords: [],
      validationIssues: [],
      artifactRefs: [],
      evidence: {
        seed: 42,
        datasetRef: 'short_after_pump-overlay',
        contractVersion: '017.1',
        moduleVersions: [],
        riskProfileRef: REF,
        executionProfileRef: REF,
        simulatedOrders: [],
        simulatedFills: [],
        riskDecisions: [],
        equityCurve: equity,
        deferredRobustness: [],
      },
    },
    variant: null,
    comparison: null,
  };
}

const SCOPE = {
  datasetRef: 'short_after_pump-overlay',
  window: { fromMs: 0, toMs: 120_000 },
  symbols: ['BTCUSDT'],
  timeframe: '1m',
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe('produceStrategyEvidence (abort-before-sign)', () => {
  let acceptedBundle: ModuleBundle;
  let cleanupAccepted: () => Promise<void>;

  beforeAll(async () => {
    const inline = loadInlineBundle('short-after-pump');
    const mat = await materializeBundle(inline);
    cleanupAccepted = mat.cleanup;
    acceptedBundle = loadBundle(mat.bundleDir);
  });

  afterAll(async () => {
    await cleanupAccepted?.();
  });

  // ── case (a) ────────────────────────────────────────────────────────────────
  it('equivalent runs + accepted bundle + passed verdict → signed artifact verifies', () => {
    const key = generateSigningKey();
    // Same reference → contentRef identical → compareBacktestRuns returns equivalent=true.
    const outcome = makeRunOutcome([WINNING_TRADE], 'run-eq');

    const r = produceStrategyEvidence({
      bundle: acceptedBundle,
      bundleBytes: Buffer.from('esm-bundle-bytes'),
      curated: outcome,
      candidate: outcome,
      scope: SCOPE,
      key,
      backtesterRunId: 'bt-test-a',
    });

    expect(r.verdict).toBe('passed');
    expect(r.signed).toBe(true);
    expect(r.artifact).toBeDefined();
    // verifySignedEvidenceLocal returns { ok: boolean }
    expect(verifySignedEvidenceLocal(r.artifact!, { [key.keyId]: key.publicKeyPem }).ok).toBe(true);
    expect(r.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.metrics.total_trades).toBe(1);
  });

  // ── case (d) ────────────────────────────────────────────────────────────────
  // Verdict failed = a legitimate judgement on REAL metrics (not a breakage). The research loop must
  // receive it as data: returned (NOT thrown), signed:false, full metrics, NO artifact. The
  // "never sign non-passing" invariant holds — no signature is produced on a failed verdict.
  it('verdict failed (real metrics) → returns data with signed:false + metrics, NO artifact, NO throw', () => {
    const key = generateSigningKey();
    // Monotone-down equity → sharpe < 0 (≤ minSharpe:0); losing trade → win_rate 0 (≤ minWinRate:0).
    const DOWN: readonly EquityPoint[] = [
      { barIndex: 0, barTs: 0, equity: 10_000 },
      { barIndex: 1, barTs: 60_000, equity: 9_900 },
      { barIndex: 2, barTs: 120_000, equity: 9_800 },
    ];
    const losingTrade = makeTrade(1, 99, -1);
    // Same outcome for curated & candidate → twin-equivalence passes; only the verdict fails.
    const outcome = makeRunOutcome([losingTrade], 'run-fail', DOWN);

    const r = produceStrategyEvidence({
      bundle: acceptedBundle,
      bundleBytes: Buffer.from('esm-bundle-bytes'),
      curated: outcome,
      candidate: outcome,
      scope: SCOPE,
      key,
      backtesterRunId: 'bt-test-d',
    });

    expect(r.signed).toBe(false);
    expect(r.verdict).toBe('failed');
    expect(r.artifact).toBeUndefined();
    expect(r.artifactRef).toBeUndefined();
    // Full metrics + bundleHash + scope are returned as data for the research loop.
    expect(r.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.metrics.total_trades).toBe(1);
    expect(typeof r.metrics.sharpe).toBe('number');
    expect(r.scope).toEqual(SCOPE);
  });

  // ── case (b) ────────────────────────────────────────────────────────────────
  it('divergent runs → throws (no artifact emitted)', () => {
    const key = generateSigningKey();
    // Different exitBarIndex → firstDivergence.field === 'exitBarIndex' (contains 'bar')
    const curatedOut = makeRunOutcome([makeTrade(1, 101, 1)], 'run-curated');
    const candidateOut = makeRunOutcome([makeTrade(2, 102, 2)], 'run-candidate');

    expect(() =>
      produceStrategyEvidence({
        bundle: acceptedBundle,
        bundleBytes: Buffer.from('esm'),
        curated: curatedOut,
        candidate: candidateOut,
        scope: SCOPE,
        key,
        backtesterRunId: 'bt-test-b',
      }),
    ).toThrow(/equivalence failed at trade #\d+ field exitBarIndex: expected 1, got 2/i);
  });

  // ── case (c) ────────────────────────────────────────────────────────────────
  it('rejected bundle → throws BEFORE signing', async () => {
    const key = generateSigningKey();
    const inline = loadInlineBundle('short-after-pump');
    const mat = await materializeBundle(inline);
    try {
      // Tamper: append bytes to entry file → recomputed bundleHash ≠ descriptor.bundleHash
      // → acceptance-gate issues bundle_integrity_violation → status: 'rejected'
      const entryAbs = join(mat.bundleDir, inline.entry);
      writeFileSync(entryAbs, `${readFileSync(entryAbs, 'utf8')}\n// tampered\n`);
      const rejectedBundle = loadBundle(mat.bundleDir);
      const outcome = makeRunOutcome([WINNING_TRADE], 'run-c');

      expect(() =>
        produceStrategyEvidence({
          bundle: rejectedBundle,
          bundleBytes: Buffer.from('esm'),
          curated: outcome,
          candidate: outcome,
          scope: SCOPE,
          key,
          backtesterRunId: 'bt-test-c',
        }),
      ).toThrow(/validation rejected/i);
    } finally {
      await mat.cleanup();
    }
  });
});
