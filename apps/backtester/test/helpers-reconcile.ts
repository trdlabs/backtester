// Strategy-agnostic paper↔backtest trade reconciliation (sub#2 scaffolding). Pure, no I/O.
// Pairs by `${symbol}|${entryTs}|${side}`; splits divergences into data-vs-engine via an
// INDEPENDENT close-to-close from CanonicalRowV2 rows (never reads the engine output). Missing
// rows ⇒ data_divergent (conservative — never blame the engine for absent data).

import type { CanonicalRowV2, StrategyModule } from '@trading/research-contracts/research';
import type { Trade } from '../src/engine/artifacts.js';
import { makeReplayModule, type PaperTrade } from './helpers-replay.js';

export type Side = 'long' | 'short';
export type ReconcileStatus =
  | 'matched' | 'engine_divergent' | 'data_divergent'
  | 'paper_only' | 'backtest_only' | 'ambiguous';

export interface NormalizedTrade {
  readonly symbol: string;
  readonly side: Side;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly closeReason: string;
  readonly pnlPct: number;
}
export interface ReconcileRow {
  readonly key: string;
  readonly status: ReconcileStatus;
  readonly paper?: NormalizedTrade;
  readonly backtest?: NormalizedTrade;
  readonly deltas?: { readonly exitTsMatch: boolean; readonly closeReasonMatch: boolean; readonly pnlPctDelta: number };
  readonly note?: string;
}
export interface ReconcileSummary {
  readonly total: number; readonly matched: number;
  readonly engineDivergent: number; readonly dataDivergent: number;
  readonly paperOnly: number; readonly backtestOnly: number; readonly ambiguous: number;
  readonly matchRate: number;
}
export interface ReconcileResult { readonly rows: readonly ReconcileRow[]; readonly summary: ReconcileSummary }

const DEFAULT_TOL = 1e-3;

export function tradeKey(t: { symbol: string; entryTs: number; side: Side }): string {
  return `${t.symbol}|${t.entryTs}|${t.side}`;
}

export function paperToNormalized(t: PaperTrade): NormalizedTrade {
  return { symbol: t.symbol, side: t.side, entryTs: t.openedAtMs, exitTs: t.closedAtMs, closeReason: t.closeReason, pnlPct: Number(t.pnlPct) };
}

/** CONTRACT: pnlPct from fill prices, side-aware (same as sub#1). NEVER from realizedPnl (USD/leverage). */
export function engineTradeToNormalized(t: Trade): NormalizedTrade {
  const pnlPct = t.side === 'short'
    ? ((t.entryFillPrice - t.exitFillPrice) / t.entryFillPrice) * 100
    : ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100;
  return { symbol: t.symbol, side: t.side, entryTs: t.entryTs, exitTs: t.exitTs, closeReason: String(t.closeReason), pnlPct };
}

function floorRow(rows: readonly CanonicalRowV2[], ts: number): CanonicalRowV2 | undefined {
  let best: CanonicalRowV2 | undefined;
  for (const r of rows) if (r.minute_ts <= ts) best = r; // rows ascending → last ≤ ts is the floor
  return best;
}

/** Independent price return from rows' closes (side-aware); undefined if a row for either minute is absent. */
export function closeToClosePnlPct(rows: readonly CanonicalRowV2[], entryTs: number, exitTs: number, side: Side): number | undefined {
  const e = floorRow(rows, entryTs);
  const x = floorRow(rows, exitTs);
  if (e === undefined || x === undefined) return undefined;
  return side === 'short'
    ? ((e.close - x.close) / e.close) * 100
    : ((x.close - e.close) / e.close) * 100;
}

function groupByKey(list: readonly NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  const m = new Map<string, NormalizedTrade[]>();
  for (const t of list) {
    const k = tradeKey(t);
    const arr = m.get(k); if (arr) arr.push(t); else m.set(k, [t]);
  }
  return m;
}

export function reconcileTrades(args: {
  paper: readonly NormalizedTrade[];
  backtest: readonly NormalizedTrade[];
  rows: Readonly<Record<string, readonly CanonicalRowV2[]>>;
  pnlPctTol?: number;
}): ReconcileResult {
  const tol = args.pnlPctTol ?? DEFAULT_TOL;
  const paperByKey = groupByKey(args.paper);
  const btByKey = groupByKey(args.backtest);
  const keys = [...new Set<string>([...paperByKey.keys(), ...btByKey.keys()])].sort();
  const rows: ReconcileRow[] = [];

  for (const key of keys) {
    const ps = paperByKey.get(key) ?? [];
    const bs = btByKey.get(key) ?? [];
    if (ps.length > 1 || bs.length > 1) {
      rows.push({ key, status: 'ambiguous', note: `paper=${ps.length} backtest=${bs.length} at one key` });
      continue;
    }
    const p = ps[0]; const b = bs[0];
    if (p && !b) { rows.push({ key, status: 'paper_only', paper: p }); continue; }
    if (!p && b) { rows.push({ key, status: 'backtest_only', backtest: b }); continue; }
    const exitTsMatch = p.exitTs === b.exitTs;
    const closeReasonMatch = p.closeReason === b.closeReason;
    const pnlPctDelta = b.pnlPct - p.pnlPct;
    const deltas = { exitTsMatch, closeReasonMatch, pnlPctDelta };
    if (exitTsMatch && closeReasonMatch && Math.abs(pnlPctDelta) <= tol) {
      rows.push({ key, status: 'matched', paper: p, backtest: b, deltas });
      continue;
    }
    const c2c = closeToClosePnlPct(args.rows[p.symbol] ?? [], p.entryTs, p.exitTs, p.side);
    if (c2c === undefined) {
      rows.push({ key, status: 'data_divergent', paper: p, backtest: b, deltas, note: 'rows missing for entry/exit minute' });
    } else if (Math.abs(c2c - p.pnlPct) > tol) {
      rows.push({ key, status: 'data_divergent', paper: p, backtest: b, deltas, note: `rows c2c ${c2c.toFixed(4)} != paper ${p.pnlPct.toFixed(4)}` });
    } else {
      rows.push({ key, status: 'engine_divergent', paper: p, backtest: b, deltas });
    }
  }
  return { rows, summary: summarize(rows) };
}

function summarize(rows: readonly ReconcileRow[]): ReconcileSummary {
  const c = (s: ReconcileStatus) => rows.filter((r) => r.status === s).length;
  const total = rows.length;
  const matched = c('matched');
  return {
    total, matched,
    engineDivergent: c('engine_divergent'), dataDivergent: c('data_divergent'),
    paperOnly: c('paper_only'), backtestOnly: c('backtest_only'), ambiguous: c('ambiguous'),
    matchRate: total === 0 ? 0 : matched / total,
  };
}

/**
 * A replay strategy that, unlike sub#1's `makeReplayModule` (which exits with a fixed synthetic
 * reason), exits carrying each paper trade's recorded `closeReason` — so the reconcile match
 * criterion's closeReason dimension is exercisable end-to-end. Reuses sub#1's entry behavior.
 */
export function makeReconcileReplayModule(symbol: string, trades: readonly PaperTrade[]): StrategyModule {
  const base = makeReplayModule(symbol, [...trades]);
  const reasonByClose = new Map(trades.map((t) => [t.closedAtMs, t.closeReason]));
  return {
    ...base,
    onPositionBar: (ctx: { bar: { ts: number } }) => {
      const reason = reasonByClose.get(ctx.bar.ts);
      return reason !== undefined ? { kind: 'exit', target: reason } : { kind: 'idle' };
    },
  } as unknown as StrategyModule;
}
