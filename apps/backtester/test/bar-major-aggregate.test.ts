import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import type { RunAccumulators } from '../src/engine/runner.js';
import { aggregateEquityCurve, mergeAccumulators } from '../src/engine/bar-major-aggregate.js';

const P = (barIndex: number, barTs: number, equity: number): EquityPoint => ({ barIndex, barTs, equity });

describe('aggregateEquityCurve (temporal sum, carry-forward)', () => {
  it('sums two fully-aligned symbols point-wise', () => {
    const a = [P(0, 100, 10_100), P(1, 200, 10_050)];
    const b = [P(0, 100, 9_900), P(1, 200, 9_800)];
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_000 },
      { barIndex: 1, barTs: 200, equity: 19_850 },
    ]);
  });

  it('carries forward: absent-before-first is INITIAL_EQUITY, absent-after-last holds last', () => {
    // symbol A: bars at ts 100,200. symbol B: bar only at ts 200.
    const a = [P(0, 100, 10_100), P(1, 200, 10_200)];
    const b = [P(0, 200, 9_500)];
    // ts=100: A=10_100, B not started → 10_000 ⇒ 20_100
    // ts=200: A=10_200, B=9_500 ⇒ 19_700
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_100 },
      { barIndex: 1, barTs: 200, equity: 19_700 },
    ]);
  });

  it('carries a symbol that ends early at its last equity', () => {
    const a = [P(0, 100, 10_100)]; // ends at ts 100
    const b = [P(0, 100, 9_900), P(1, 200, 9_700)];
    // ts=100: 10_100 + 9_900 = 20_000; ts=200: A holds 10_100 + B 9_700 = 19_800
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_000 },
      { barIndex: 1, barTs: 200, equity: 19_800 },
    ]);
  });
});

describe('mergeAccumulators (deterministic ordering)', () => {
  const emptyAcc = (): RunAccumulators => ({
    decisionRecords: [], orders: [], fills: [], riskDecisions: [],
    trades: [], equityCurve: [], fundingLedger: [], validationIssues: [],
  });

  it('merges trades by exitTs asc then request.symbols order', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.trades as unknown[]).push({ symbol: 'A', exitTs: 200, id: 'a2' }, { symbol: 'A', exitTs: 100, id: 'a1' });
    (accB.trades as unknown[]).push({ symbol: 'B', exitTs: 100, id: 'b1' });
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.trades.map((t) => (t as { id: string }).id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('aggregates equityCurve via temporal sum', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.equityCurve as EquityPoint[]).push(P(0, 100, 10_100));
    (accB.equityCurve as EquityPoint[]).push(P(0, 100, 9_900));
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.equityCurve).toEqual([{ barIndex: 0, barTs: 100, equity: 20_000 }]);
  });

  it('merges orders by decisionBarIndex asc, then request.symbols order on ties', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.orders as unknown[]).push({ id: 'oa0', decisionBarIndex: 0 }, { id: 'oa2', decisionBarIndex: 2 });
    (accB.orders as unknown[]).push({ id: 'ob0', decisionBarIndex: 0 }, { id: 'ob1', decisionBarIndex: 1 });
    const merged = mergeAccumulators([accA, accB]);
    // idx0: A before B (symbolIndex tie-break) → oa0, ob0; then idx1 ob1; then idx2 oa2
    expect(merged.orders.map((o) => (o as { id: string }).id)).toEqual(['oa0', 'ob0', 'ob1', 'oa2']);
  });

  it('concatenates key-less validationIssues in request.symbols order', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.validationIssues as unknown[]).push({ code: 'a1' }, { code: 'a2' });
    (accB.validationIssues as unknown[]).push({ code: 'b1' });
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.validationIssues.map((v) => (v as { code: string }).code)).toEqual(['a1', 'a2', 'b1']);
  });
});
