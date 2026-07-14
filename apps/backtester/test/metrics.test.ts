// E1a — unit tests for the expanded metric catalog (engine/metrics.ts::computeMetrics).
// One fixture is engineered so every metric has an EXACT hand-computed value; edge-case and
// non-regression tests pin the fail-closed conventions and the byte-identity invariant.

import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { computeMetrics, effectiveElapsedYears } from '../src/engine/metrics.js';

function eq(values: readonly number[]): EquityPoint[] {
  return values.map((equity, i) => ({ barIndex: i, barTs: i * 60_000, equity }));
}

function trade(realizedPnl: number, i: number): Trade {
  return {
    id: `t${i}`,
    symbol: 'BTCUSDT',
    side: realizedPnl >= 0 ? 'long' : 'short',
    entryBarIndex: i,
    entryTs: i * 60_000,
    entryFillPrice: 100,
    exitBarIndex: i + 1,
    exitTs: (i + 1) * 60_000,
    exitFillPrice: 100 + realizedPnl,
    size: 1,
    feePaid: 0,
    realizedPnl,
    closeReason: 'end_of_data',
  };
}

const ALL = [
  'sortino',
  'expectancy',
  'sqn',
  'cagr',
  'calmar',
  'returns_stddev',
  'returns_skew',
  'returns_kurtosis',
  'returns_count',
  'sharpe',
  'pnl',
  'max_drawdown',
  'win_rate',
  'total_trades',
  'profit_factor',
  'top_trade_contribution_pct',
];

describe('computeMetrics — expanded catalog (E1a)', () => {
  // equity returns = [0.2, -0.1, 0.2, -0.1]; trades pnl = [30, -10, 30, -10]; elapsedYears = 2.
  // Hand-computed so every value is exact under 8-place quantization.
  const equity = eq([100, 120, 108, 129.6, 116.64]);
  const trades = [trade(30, 0), trade(-10, 1), trade(30, 2), trade(-10, 3)];
  const ctx = { elapsedYears: 2 };

  it('computes every metric to its exact hand-computed value', () => {
    const m = computeMetrics(ALL, equity, trades, ctx);
    // returns-series family
    expect(m.sharpe).toBeCloseTo(0.33333333, 8); // mean 0.05 / std 0.15
    expect(m.sortino).toBeCloseTo(0.70710678, 8); // 0.05 / sqrt(0.005)
    expect(m.returns_stddev).toBeCloseTo(0.15, 8);
    expect(m.returns_skew).toBeCloseTo(0, 8); // symmetric
    expect(m.returns_kurtosis).toBeCloseTo(1, 8); // Pearson, two-value symmetric ⇒ 1
    expect(m.returns_count).toBe(4);
    // time family (calendar CAGR)
    expect(m.cagr).toBeCloseTo(0.08, 8); // sqrt(1.1664) - 1
    expect(m.calmar).toBeCloseTo(0.8, 8); // 0.08 / 0.1
    // trade family
    expect(m.expectancy).toBeCloseTo(10, 8);
    expect(m.sqn).toBeCloseTo(1, 8); // (10/20) * sqrt(4)
    // existing metrics unchanged
    expect(m.pnl).toBeCloseTo(16.64, 8);
    expect(m.max_drawdown).toBeCloseTo(0.1, 8);
    expect(m.win_rate).toBeCloseTo(0.5, 8);
    expect(m.profit_factor).toBeCloseTo(3, 8);
    expect(m.top_trade_contribution_pct).toBeCloseTo(50, 8);
  });

  it('omits cagr/calmar when elapsedYears is null', () => {
    const m = computeMetrics(['cagr', 'calmar'], equity, trades, { elapsedYears: null });
    expect('cagr' in m).toBe(false);
    expect('calmar' in m).toBe(false);
  });

  it('omits calmar when max_drawdown is 0 (monotonic equity)', () => {
    const m = computeMetrics(['cagr', 'calmar'], eq([100, 110, 121]), [], { elapsedYears: 1 });
    expect(m.cagr).toBeCloseTo(0.21, 8); // 121/100 - 1 over 1y
    expect('calmar' in m).toBe(false);
  });

  it('omits cagr (and calmar) when final equity is non-positive', () => {
    const m = computeMetrics(['cagr', 'calmar'], eq([100, -5]), [], { elapsedYears: 1 });
    expect('cagr' in m).toBe(false);
    expect('calmar' in m).toBe(false);
  });

  it('returns 0 for the whole returns family when a prior equity is 0', () => {
    const m = computeMetrics(
      ['sharpe', 'sortino', 'returns_stddev', 'returns_skew', 'returns_kurtosis', 'returns_count'],
      eq([100, 0, 50]),
      [],
      { elapsedYears: 1 },
    );
    expect(m.sharpe).toBe(0);
    expect(m.sortino).toBe(0);
    expect(m.returns_stddev).toBe(0);
    expect(m.returns_skew).toBe(0);
    expect(m.returns_kurtosis).toBe(0);
    expect(m.returns_count).toBe(0);
  });

  it('returns 0 for returns metrics with fewer than 2 return observations', () => {
    const m = computeMetrics(['sharpe', 'sortino', 'returns_stddev', 'returns_count'], eq([100, 110]), [], {
      elapsedYears: 1,
    });
    expect(m.sharpe).toBe(0);
    expect(m.sortino).toBe(0);
    expect(m.returns_stddev).toBe(0);
    expect(m.returns_count).toBe(1); // one return was actually built
  });

  it('returns 0 for expectancy and sqn with no closed trades', () => {
    const m = computeMetrics(['expectancy', 'sqn'], equity, [], ctx);
    expect(m.expectancy).toBe(0);
    expect(m.sqn).toBe(0);
  });

  it('is deterministic — identical input yields identical output', () => {
    const a = computeMetrics(ALL, equity, trades, ctx);
    const b = computeMetrics(ALL, equity, trades, ctx);
    expect(a).toEqual(b);
  });

  // Non-regression: requesting only the pre-E1a set must yield EXACTLY those keys — no new DSR
  // ingredients auto-added, sharpe byte-identical.
  it('adds no new keys when only the legacy metric set is requested', () => {
    const legacy = [
      'pnl',
      'max_drawdown',
      'win_rate',
      'sharpe',
      'total_trades',
      'profit_factor',
      'top_trade_contribution_pct',
    ];
    const m = computeMetrics(legacy, equity, trades, ctx);
    expect(Object.keys(m).sort()).toEqual([...legacy].sort());
  });

  it('ignores unknown metric names', () => {
    const m = computeMetrics(['definitely_not_a_metric'], equity, trades, ctx);
    expect(m).toEqual({});
  });
});

// P3-7 — effective elapsed time is derived from the REALLY-PROCESSED unique bar timestamps
// (acc.equityCurve[].barTs), not the requested period. cagr uses equity[last]/equity[first], and each
// EquityPoint is recorded AFTER its bar closes (at barTs), so the return's elapsed time is exactly the
// span between the two post-close observations: lastTs - firstTs (no +timeframe).
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const eqTs = (tss: readonly number[]) => tss.map((barTs, i) => ({ barIndex: i, barTs, equity: 100 }));

describe('effectiveElapsedYears (P3-7 — processed bars, not requested period)', () => {
  it('full coverage: lastTs - firstTs over unique bar timestamps', () => {
    // observations at 0/60k/120k → span = 120k - 0 = 120k ms (NOT 180k — no synthetic +timeframe)
    expect(effectiveElapsedYears(eqTs([0, 60_000, 120_000]))).toBeCloseTo(120_000 / MS_PER_YEAR, 12);
  });

  it('truncated start: denominator uses firstTs of processed data, not request.from', () => {
    // processed bars begin 10 min into the window → firstTs = 600k, NOT the requested from
    expect(effectiveElapsedYears(eqTs([600_000, 660_000, 720_000]))).toBeCloseTo(120_000 / MS_PER_YEAR, 12);
  });

  it('truncated end: uses lastTs of processed data, not request.to', () => {
    expect(effectiveElapsedYears(eqTs([0, 60_000]))).toBeCloseTo(60_000 / MS_PER_YEAR, 12); // 60k - 0
  });

  it('gaps count as calendar time (max - min spans the gap)', () => {
    // 0, 60k, [120k missing], 180k, 240k → span = 240k - 0 = 240k
    expect(effectiveElapsedYears(eqTs([0, 60_000, 180_000, 240_000]))).toBeCloseTo(240_000 / MS_PER_YEAR, 12);
  });

  it('multi-symbol duplicate timestamps do NOT widen the window', () => {
    // two symbols, same three timestamps each → unique {0,60k,120k} → 120k, not six points
    expect(effectiveElapsedYears(eqTs([0, 60_000, 120_000, 0, 60_000, 120_000]))).toBeCloseTo(120_000 / MS_PER_YEAR, 12);
  });

  it('omits (null) when fewer than two DISTINCT timestamps', () => {
    expect(effectiveElapsedYears(eqTs([0]))).toBeNull();
    expect(effectiveElapsedYears(eqTs([5_000, 5_000, 5_000]))).toBeNull(); // duplicate single ts
    expect(effectiveElapsedYears([])).toBeNull();
  });

  it('integration — exact CAGR from the processed-bar span (endpoint/time coupling)', () => {
    // Two post-close observations exactly half a year apart, equity 100 → 121. The window is
    // lastTs - firstTs = 0.5y, so cagr = (121/100)^(1/0.5) - 1 = 1.21^2 - 1 = 0.4641 EXACTLY.
    const e = [
      { barIndex: 0, barTs: 0, equity: 100 },
      { barIndex: 1, barTs: 0.5 * MS_PER_YEAR, equity: 121 },
    ];
    expect(effectiveElapsedYears(e)).toBeCloseTo(0.5, 12);
    const m = computeMetrics(['cagr'], e, [], { elapsedYears: effectiveElapsedYears(e) });
    expect(m.cagr).toBeCloseTo(0.4641, 6); // 1.21^2 - 1, pinned exactly
  });

  it('a smaller REAL processed window yields a higher annualized cagr than a full-year denominator', () => {
    // Two observations a tenth of a year apart → window = 0.1y (lastTs - firstTs). Dividing by the real
    // 0.1y (instead of a requested full year) raises the annualized cagr — the P3-7 correction.
    const e = [
      { barIndex: 0, barTs: 0, equity: 100 },
      { barIndex: 1, barTs: 0.1 * MS_PER_YEAR, equity: 121 },
    ];
    expect(effectiveElapsedYears(e)).toBeCloseTo(0.1, 12);
    const partial = computeMetrics(['cagr'], e, [], { elapsedYears: effectiveElapsedYears(e) }).cagr;
    const asIfFullYear = computeMetrics(['cagr'], e, [], { elapsedYears: 1 }).cagr;
    expect(Number.isFinite(partial)).toBe(true);
    expect(partial).toBeGreaterThan(asIfFullYear!);
  });
});
