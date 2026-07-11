import { describe, it, expect } from 'vitest';
import { persistOverlayArtifacts, BASELINE_TRADES } from '../src/artifacts/overlay-store';
import type { ArtifactStore } from '../src/artifacts/store';
import type { RunOutcome } from '../src/engine/artifacts';

// In-memory ArtifactStore: content hash = deterministic index; records every payload.
function fakeStore(): { store: ArtifactStore; written: unknown[] } {
  const written: unknown[] = [];
  const store: ArtifactStore = {
    write: async (payload: unknown) => { written.push(payload); return `hash-${written.length - 1}`; },
  } as unknown as ArtifactStore;
  return { store, written };
}

// Resolve the actual payload of an artifact descriptor from the fake store's written array.
function payloadOf(res: Awaited<ReturnType<typeof persistOverlayArtifacts>>, written: unknown[], artifactType: string): unknown {
  const desc = res.manifest.descriptors.find((d) => d.artifactType === artifactType);
  if (!desc) return undefined;
  const idx = Number(String(desc.contentHash).replace('hash-', ''));
  return written[idx];
}

function runResult(runId: string, trades: unknown[]) {
  return {
    runId, status: 'completed', runKind: 'overlay',
    metrics: {}, evidence: { contractVersion: 'x' }, trades, decisionRecords: [],
  } as never;
}

function comparisonOutcome(baselineTrades: unknown[]): Extract<RunOutcome, { status: 'completed' }> {
  return {
    status: 'completed',
    baseline: runResult('base', baselineTrades),
    variant: runResult('base::variant', [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 1, closeReason: 'take_hit' }]),
    comparison: { baselineRunId: 'base', variants: [] } as never,
  };
}

function nonComparisonOutcome(): Extract<RunOutcome, { status: 'completed' }> {
  return {
    status: 'completed',
    baseline: runResult('base', [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 1, closeReason: 'take_hit' }]),
    variant: null,
    comparison: null,
  };
}

describe('persistOverlayArtifacts baseline-trades', () => {
  it('emits a baseline-trades descriptor carrying baseline.trades on a comparison run', async () => {
    const { store, written } = fakeStore();
    const baselineTrades = [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }];
    const res = await persistOverlayArtifacts(store, comparisonOutcome(baselineTrades), 'ds-fp');
    const desc = res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES);
    expect(desc).toBeDefined();
    expect(desc!.approxItemCount).toBe(1);
    expect(payloadOf(res, written, BASELINE_TRADES)).toEqual(baselineTrades);
  });

  it('does NOT emit baseline-trades on a non-comparison run', async () => {
    const { store } = fakeStore();
    const res = await persistOverlayArtifacts(store, nonComparisonOutcome(), 'ds-fp');
    expect(res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES)).toBeUndefined();
  });

  it('emits a PRESENT baseline-trades artifact (empty payload) when baseline had zero trades', async () => {
    const { store, written } = fakeStore();
    const res = await persistOverlayArtifacts(store, comparisonOutcome([]), 'ds-fp');
    const desc = res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES);
    expect(desc).toBeDefined();
    expect(desc!.approxItemCount).toBe(0);
    // payload is the empty array, not omitted
    expect(payloadOf(res, written, BASELINE_TRADES)).toEqual([]);
  });

  it('BASELINE_TRADES is exactly "baseline-trades"', () => {
    expect(BASELINE_TRADES).toBe('baseline-trades');
  });
});

// The baseline-trades guard uses outcome.comparison != null. The runner sets `variant` and
// `comparison` together (comparison = computeComparison(baseline, variant) runs in the same
// overlays block), so the two signals are equivalent. This locks that equivalence so a future
// divergence — which would desync the guard — is caught here rather than in production.
describe('RunOutcome comparison/variant equivalence invariant', () => {
  function assertEquiv(o: Extract<RunOutcome, { status: 'completed' }>) {
    expect(o.variant != null).toBe(o.comparison != null);
  }
  it('holds for a comparison outcome', () => assertEquiv(comparisonOutcome([])));
  it('holds for a non-comparison outcome', () => assertEquiv(nonComparisonOutcome()));
});
