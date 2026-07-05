import { describe, expect, it } from 'vitest';
import type { RunResultSummary, ComparisonSummary } from '@trading/research-contracts';

describe('RunResultSummary.comparison (additive, optional)', () => {
  it('momentum-style summary omits comparison and round-trips', () => {
    const s: RunResultSummary = {
      runId: 'r1', status: 'completed', metrics: { pnl: 1 },
      artifactRefs: [], evidence: { seed: 42, contractVersion: '017.2', moduleVersions: [], datasetRef: 'd' },
    };
    const wire = JSON.parse(JSON.stringify(s)) as RunResultSummary;
    expect('comparison' in wire).toBe(false);   // KEY: omitted, not null
    expect(wire.comparison).toBeUndefined();
    expect(wire.metrics.pnl).toBe(1);
  });

  it('overlay-style summary carries a populated comparison and round-trips', () => {
    const comparison: ComparisonSummary = {
      baselineRunId: 'r2',
      variants: [{
        runId: 'r2::variant', overlayRefs: [{ id: 'ov', version: '0.1.0' }],
        metricDeltas: { pnl: { baseline: 1, variant: 2, delta: 1 } },
        tradeOutcomeChanged: true,
        overlayEffectsSummary: { pass: 0, annotate: 0, patch: 1, veto: 0 },
      }],
    };
    const s: RunResultSummary = {
      runId: 'r2', status: 'completed', metrics: { pnl: 2 },
      artifactRefs: [], evidence: { seed: 42, contractVersion: '017.2', moduleVersions: [], datasetRef: 'd' },
      comparison,
    };
    const wire = JSON.parse(JSON.stringify(s)) as RunResultSummary;
    expect(wire.comparison?.variants[0].metricDeltas.pnl.delta).toBe(1);
    expect(wire.comparison?.variants[0].overlayEffectsSummary.patch).toBe(1);
  });
});
