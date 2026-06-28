// TDD gate: toOverlaySummary evidenceRef passthrough (Task E3).
//
// Dev run from monorepo root:
//   pnpm exec vitest run apps/backtester/test/overlay-summary.test.ts

import { describe, expect, it } from 'vitest';

import type { EquityPoint, RunOutcome } from '../src/engine/artifacts.js';
import { toOverlaySummary } from '../src/jobs/overlay-summary.js';
import type { ArtifactReference, ContentHash } from '@trading/research-contracts';

// ── minimal completed RunOutcome ──────────────────────────────────────────────
// Shape mirrors makeRunOutcome() from produce-strategy-evidence.test.ts.

const EQUITY: readonly EquityPoint[] = [
  { barIndex: 0, barTs: 0, equity: 10_000 },
  { barIndex: 1, barTs: 60_000, equity: 10_100 },
  { barIndex: 2, barTs: 120_000, equity: 10_200 },
];

const REF = { id: 'default', version: '1.0.0' };

const OUTCOME: Extract<RunOutcome, { status: 'completed' }> = {
  status: 'completed',
  baseline: {
    runId: 'run-test-1',
    summary: {
      targetKind: 'baseline',
      moduleRef: REF,
      overlayRefs: [],
      symbols: ['BTCUSDT'],
      barsProcessed: 3,
      ordersCount: 0,
      closedTradesCount: 0,
    },
    metrics: {},
    trades: [],
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
      equityCurve: EQUITY,
      deferredRobustness: [],
    },
  },
  variant: null,
  comparison: null,
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('toOverlaySummary', () => {
  it('includes evidenceRef in summary when provided as trailing arg', () => {
    const ref: ArtifactReference = {
      artifactId: 'sha256:abcdef' as ContentHash,
      artifactType: 'backtest-evidence/v1',
      availability: 'available',
    };
    const summary = toOverlaySummary(
      OUTCOME,
      'r1',
      [],
      'sha256:hh' as ContentHash,
      'fp',
      undefined,
      ref,
    );
    expect(summary.evidenceRef).toEqual(ref);
  });

  it('omits evidenceRef from summary when arg is not provided', () => {
    const summary = toOverlaySummary(
      OUTCOME,
      'r1',
      [],
      'sha256:hh' as ContentHash,
      'fp',
    );
    expect(summary.evidenceRef).toBeUndefined();
  });
});
