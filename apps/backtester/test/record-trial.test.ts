// E2 — the finalize-time orchestrator: record this run in the ledger, compute the advisory
// TrialContext (DSR + N) from the family's history. This is the flag-gated seam the worker calls.

import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import { InMemoryTrialLedger } from '../src/jobs/ledger/trial-ledger.js';
import { recordTrialAndComputeContext } from '../src/jobs/ledger/record-trial.js';

function eq(values: readonly number[]): EquityPoint[] {
  return values.map((equity, i) => ({ barIndex: i, barTs: i * 60_000, equity }));
}

const REQUEST = {
  trialFamilyHint: undefined as string | undefined,
  moduleRef: { id: 'short_after_pump' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
};
const EQUITY = eq([100, 120, 108, 129.6, 116.64]); // sharpe 1/3, T 4 — valid
const deps = (ledger: InMemoryTrialLedger) => ({ ledger, empiricalMinN: 5, clock: () => 1_000_000 });

describe('recordTrialAndComputeContext', () => {
  it('records the first trial and returns N=1 advisory context (cold start, asymptotic)', async () => {
    const ledger = new InMemoryTrialLedger();
    const ctx = await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST,
      requestFingerprint: 'fp-1',
      runId: 'run-1',
      resultHash: 'sha256:aaa',
      equity: EQUITY,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.trialCount).toBe(1);
    expect(ctx!.vSRBasis).toBe('asymptotic');
    expect(ctx!.familyKey.length).toBeGreaterThan(0);
    expect(ctx!.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(ctx!.deflatedSharpe).toBeLessThanOrEqual(1);
  });

  it('counts a second distinct trial in the same family as N=2', async () => {
    const ledger = new InMemoryTrialLedger();
    await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: EQUITY,
    });
    const ctx2 = await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-2', runId: 'run-2', resultHash: 'sha256:b', equity: EQUITY,
    });
    expect(ctx2!.trialCount).toBe(2);
  });

  it('does not inflate N when the same requestFingerprint is replayed', async () => {
    const ledger = new InMemoryTrialLedger();
    await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: EQUITY,
    });
    const replay = await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1-again', resultHash: 'sha256:a', equity: EQUITY,
    });
    expect(replay!.trialCount).toBe(1);
  });

  it('returns null for a degenerate run (fewer than 2 returns)', async () => {
    const ledger = new InMemoryTrialLedger();
    const ctx = await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: eq([100, 110]),
    });
    expect(ctx).toBeNull();
  });

  it('returns a context whose numbers are all finite', async () => {
    const ledger = new InMemoryTrialLedger();
    const ctx = await recordTrialAndComputeContext(deps(ledger), {
      request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: EQUITY,
    });
    for (const v of [ctx!.trialCount, ctx!.deflatedSharpe, ctx!.sr0, ctx!.vSR, ctx!.tCount]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
