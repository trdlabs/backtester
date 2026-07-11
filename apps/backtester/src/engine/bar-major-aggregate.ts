import type { EquityPoint } from './artifacts.js';
import type { RunAccumulators } from './runner.js';
import { INITIAL_EQUITY } from './metrics.js';

/**
 * Temporal-sum aggregate equity across per-symbol curves (index order = request.symbols order).
 * At each union timestamp, aggregate = Σ each symbol's equity at the greatest bar ≤ ts, or
 * INITIAL_EQUITY before that symbol's first bar (absent-symbol carry-forward).
 */
export function aggregateEquityCurve(perSymbolCurves: readonly (readonly EquityPoint[])[]): EquityPoint[] {
  const tsSet = new Set<number>();
  for (const curve of perSymbolCurves) for (const p of curve) tsSet.add(p.barTs);
  const unionTs = [...tsSet].sort((a, b) => a - b);
  const ptr = perSymbolCurves.map(() => 0);
  const last = perSymbolCurves.map(() => INITIAL_EQUITY);
  const out: EquityPoint[] = [];
  for (let u = 0; u < unionTs.length; u += 1) {
    const ts = unionTs[u];
    let sum = 0;
    for (let s = 0; s < perSymbolCurves.length; s += 1) {
      const curve = perSymbolCurves[s];
      while (ptr[s] < curve.length && curve[ptr[s]].barTs <= ts) {
        last[s] = curve[ptr[s]].equity;
        ptr[s] += 1;
      }
      sum += last[s];
    }
    out.push({ barIndex: u, barTs: ts, equity: sum });
  }
  return out;
}

/** Stable temporal merge: primary numeric key asc, then symbol (list) index, then per-list index. */
function mergeByKey<T>(lists: readonly (readonly T[])[], keyOf: (item: T) => number): T[] {
  const tagged = lists.flatMap((list, symbolIndex) => list.map((item, origIndex) => ({ item, symbolIndex, origIndex })));
  tagged.sort((a, b) => keyOf(a.item) - keyOf(b.item) || a.symbolIndex - b.symbolIndex || a.origIndex - b.origIndex);
  return tagged.map((t) => t.item);
}

/** Concat per-symbol in request.symbols (index) order, preserving each list's own order. */
function concatBySymbol<T>(lists: readonly (readonly T[])[]): T[] {
  return lists.flatMap((list) => [...list]);
}

/**
 * Merge N per-symbol accumulators (index order = request.symbols order) into one.
 * Every list with a stable numeric key is sorted by (key asc, symbolIndex, per-symbol index);
 * ONLY a genuinely key-less list (validationIssues) falls back to deterministic per-symbol concat.
 * Confirmed field keys (from artifacts.ts / runner.ts):
 *   equityCurve  → temporal sum (special)
 *   trades       → Trade.exitTs           (real ts)
 *   decisionRecords → DecisionRecord.barTs (real ts)
 *   fills        → SimulatedFill.fillTs    (real ts)
 *   fundingLedger → FundingLedgerEntry.ts  (real ts)
 *   orders       → MutableOrder.decisionBarIndex (per-symbol bar index — no ts on the type)
 *   riskDecisions → RiskDecision.barIndex  (per-symbol bar index — no ts on the type)
 *   validationIssues → { code, severity, path?, message } — no numeric key → concat per symbol
 */
export function mergeAccumulators(perSymbol: readonly RunAccumulators[]): RunAccumulators {
  return {
    equityCurve: aggregateEquityCurve(perSymbol.map((a) => a.equityCurve)),
    trades: mergeByKey(perSymbol.map((a) => a.trades), (t) => t.exitTs),
    decisionRecords: mergeByKey(perSymbol.map((a) => a.decisionRecords), (r) => r.barTs),
    fills: mergeByKey(perSymbol.map((a) => a.fills), (f) => f.fillTs),
    fundingLedger: mergeByKey(perSymbol.map((a) => a.fundingLedger), (f) => f.ts),
    orders: mergeByKey(perSymbol.map((a) => a.orders), (o) => o.decisionBarIndex),
    riskDecisions: mergeByKey(perSymbol.map((a) => a.riskDecisions), (r) => r.barIndex),
    validationIssues: concatBySymbol(perSymbol.map((a) => a.validationIssues)),
  };
}
