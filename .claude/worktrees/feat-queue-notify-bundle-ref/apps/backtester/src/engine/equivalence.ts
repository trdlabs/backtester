import type { RunOutcome, Trade } from './artifacts.js';
import { contentRef } from '../determinism/hash.js';

export interface TradeDivergence {
  readonly index: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface EquivalenceResult {
  readonly equivalent: boolean;
  readonly resultHashMatch: boolean;
  readonly firstDivergence?: TradeDivergence;
  readonly curatedTradeCount: number;
  readonly candidateTradeCount: number;
}

/**
 * Economics-parity fields checked per-trade in declaration order.
 * NOTE: real Trade uses entryFillPrice/exitFillPrice/realizedPnl
 * (brief assumed entryPrice/exitPrice/pnlPct — those fields do NOT exist on Trade).
 *
 * Scope: this is ECONOMICS parity, not full trade identity. Intentionally EXCLUDED:
 * `symbol` (identity, not economics) and `closeKind`/`closeSeq` (partial-close bookkeeping).
 * Any divergence in those is still caught by Layer 1 (result_hash via contentRef hashes the
 * whole RunOutcome); they are omitted here only from the per-trade field-level diagnostic.
 */
const TRADE_FIELDS: readonly (keyof Trade)[] = [
  'side',
  'entryBarIndex',
  'entryTs',
  'entryFillPrice',
  'exitBarIndex',
  'exitTs',
  'exitFillPrice',
  'size',
  'feePaid',
  'realizedPnl',
  'closeReason',
];

function firstTradeDivergence(
  a: readonly Trade[],
  b: readonly Trade[],
): TradeDivergence | undefined {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    for (const f of TRADE_FIELDS) {
      if (a[i]![f] !== b[i]![f]) {
        return { index: i, field: String(f), expected: a[i]![f], actual: b[i]![f] };
      }
    }
  }
  if (a.length !== b.length) {
    return { index: n, field: 'count', expected: a.length, actual: b.length };
  }
  return undefined;
}

/**
 * Byte/economics parity of two backtest runs (curated trusted baseline ↔ kind:'strategy' bundle).
 *
 * Layer 1: result_hash via `contentRef` (canonical SHA-256 of the full RunOutcome).
 * Layer 2: per-trade field diff → first diverging trade as `firstDivergence{index,field,expected,actual}`.
 *
 * `equivalent = resultHashMatch && firstDivergence === undefined`.
 *
 * PURE — no fs, no network, no Date.now, no random. Used by Task 7 sign flow.
 */
export function compareBacktestRuns(
  curated: RunOutcome,
  candidate: RunOutcome,
): EquivalenceResult {
  if (curated.status !== 'completed' || candidate.status !== 'completed') {
    return {
      equivalent: false,
      resultHashMatch: false,
      curatedTradeCount: curated.status === 'completed' ? curated.baseline.trades.length : 0,
      candidateTradeCount: candidate.status === 'completed' ? candidate.baseline.trades.length : 0,
    };
  }

  const resultHashMatch = contentRef(curated) === contentRef(candidate);
  const div = firstTradeDivergence(curated.baseline.trades, candidate.baseline.trades);

  return {
    equivalent: resultHashMatch && div === undefined,
    resultHashMatch,
    ...(div !== undefined ? { firstDivergence: div } : {}),
    curatedTradeCount: curated.baseline.trades.length,
    candidateTradeCount: candidate.baseline.trades.length,
  };
}
