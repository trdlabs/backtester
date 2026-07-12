// E1b — worker finalize wiring for run diagnostics (resolveRunDiagnostics). Pins: flag OFF ⇒ no
// field; flag ON ⇒ diagnostics computed from the run. resultHash invariance is STRUCTURAL (the
// diagnostics are merged onto the summary projection AFTER contentRef(payload), never into payload)
// + the flag-OFF goldens.

import { describe, expect, it } from 'vitest';
import type { Trade } from '../src/engine/artifacts.js';
import { resolveRunDiagnostics, type WorkerDeps } from '../src/jobs/worker.js';

type CompletedOutcome = Parameters<typeof resolveRunDiagnostics>[1];

function trade(i: number, pnl: number): Trade {
  return {
    id: `t${i}`,
    symbol: 'BTCUSDT',
    side: pnl >= 0 ? 'long' : 'short',
    entryBarIndex: i,
    entryTs: i * 60_000,
    entryFillPrice: 100,
    exitBarIndex: i + 1,
    exitTs: (i + 1) * 60_000,
    exitFillPrice: 100 + pnl,
    size: 1,
    feePaid: 0,
    realizedPnl: pnl,
    closeReason: 'end_of_data',
  };
}

function completedOutcome(): CompletedOutcome {
  return {
    status: 'completed',
    baseline: {
      trades: [trade(0, 10), trade(1, -5)],
      evidence: { equityCurve: [100, 110, 105].map((equity, i) => ({ barIndex: i, barTs: i * 60_000, equity })) },
      summary: { barsProcessed: 10, ordersCount: 4 },
    },
  } as unknown as CompletedOutcome;
}

function deps(over: Partial<WorkerDeps>): WorkerDeps {
  return { ...over } as unknown as WorkerDeps;
}

describe('resolveRunDiagnostics — E1b worker wiring', () => {
  it('flag OFF ⇒ undefined (summary carries no diagnostics field)', () => {
    expect(resolveRunDiagnostics(deps({}), completedOutcome())).toBeUndefined();
  });

  it('flag ON ⇒ diagnostics computed with config thresholds', () => {
    const d = resolveRunDiagnostics(
      deps({ diagnostics: { enabled: true, minTrades: 30, concentrationPct: 80 } }),
      completedOutcome(),
    );
    expect(d).toBeDefined();
    expect(d!.facts.tradeCount).toBe(2);
    expect(d!.facts.orderCount).toBe(4);
    expect(d!.facts.winningTrades).toBe(1);
    expect(d!.facts.losingTrades).toBe(1);
    expect(d!.flags).toContain('underpowered'); // 2 < 30
    expect(d!.policy).toEqual({ minTrades: 30, concentrationPct: 80 });
  });
});
