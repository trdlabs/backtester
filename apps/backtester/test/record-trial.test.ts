// E2 — the finalize-time orchestrator: record this run in the ledger, compute the advisory
// TrialContext (DSR + N) from the family's history. This is the flag-gated seam the worker calls.

import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import { InMemoryTrialLedger, type TrialLedger } from '../src/jobs/ledger/trial-ledger.js';
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

  // Advisory-safety hardening (fast-follow to E5a's review): a ledger I/O fault must NEVER fail an
  // otherwise-successful run. recordIfNew failure is swallowed (best-effort insert); query failure
  // drops the advisory context (null). Mirrors E5a resolveNovelty.
  const throwingLedger = (which: 'record' | 'query'): TrialLedger => ({
    async recordIfNew() {
      if (which === 'record') throw new Error('ledger down');
      return true;
    },
    async query() {
      if (which === 'query') throw new Error('ledger down');
      return [];
    },
  });

  it('does not fail the run when the ledger recordIfNew throws (best-effort insert)', async () => {
    const ctx = await recordTrialAndComputeContext(
      { ledger: throwingLedger('record'), empiricalMinN: 5, clock: () => 1_000_000 },
      { request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: EQUITY },
    );
    // The insert throw is swallowed and the call resolves — a valid context or null, never a rejection.
    expect(ctx === null || typeof ctx.trialCount === 'number').toBe(true);
  });

  it('drops the advisory context (null) when the ledger query throws, without failing the run', async () => {
    const ctx = await recordTrialAndComputeContext(
      { ledger: throwingLedger('query'), empiricalMinN: 5, clock: () => 1_000_000 },
      { request: REQUEST, requestFingerprint: 'fp-1', runId: 'run-1', resultHash: 'sha256:a', equity: EQUITY },
    );
    expect(ctx).toBeNull();
  });

  // research-validation-hardening R1(b): a lab experiment (N parameter trials of one hypothesis) shares
  // ONE trialFamilyHint + market context/window; every trial accumulates into the SAME family with a
  // monotonically increasing trialCount, regardless of what strategy params produced each equity curve
  // (params are deliberately NOT part of FamilyKeyInput).
  const EXPERIMENT = { ...REQUEST, trialFamilyHint: 'oi-divergence-v3' };
  it('N runs of one experiment (same trialFamilyHint) accumulate under one family, trialCount 1..N', async () => {
    const ledger = new InMemoryTrialLedger();
    const N = 4;
    let lastFamilyKey: string | undefined;
    for (let i = 1; i <= N; i += 1) {
      const ctx = await recordTrialAndComputeContext(deps(ledger), {
        request: EXPERIMENT,
        requestFingerprint: `fp-experiment-${i}`,
        runId: `run-experiment-${i}`,
        resultHash: `sha256:experiment-${i}`,
        equity: EQUITY,
      });
      expect(ctx).not.toBeNull();
      expect(ctx!.trialCount).toBe(i); // monotonic 1..N
      if (lastFamilyKey !== undefined) expect(ctx!.familyKey).toBe(lastFamilyKey); // one family throughout
      lastFamilyKey = ctx!.familyKey;
    }
    expect((await ledger.query(lastFamilyKey!)).length).toBe(N);
  });

  it('a different period is a DIFFERENT family — trialCount resets, does not inherit N', async () => {
    const ledger = new InMemoryTrialLedger();
    const ctxJan = await recordTrialAndComputeContext(deps(ledger), {
      request: EXPERIMENT, requestFingerprint: 'fp-jan', runId: 'run-jan', resultHash: 'sha256:jan', equity: EQUITY,
    });
    const febRequest = { ...EXPERIMENT, period: { from: '2024-02-01T00:00:00.000Z', to: '2024-02-08T00:00:00.000Z' } };
    const ctxFeb = await recordTrialAndComputeContext(deps(ledger), {
      request: febRequest, requestFingerprint: 'fp-feb', runId: 'run-feb', resultHash: 'sha256:feb', equity: EQUITY,
    });
    expect(ctxFeb!.familyKey).not.toBe(ctxJan!.familyKey);
    expect(ctxFeb!.trialCount).toBe(1);
  });
});
