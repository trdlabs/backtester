// E1b — pure, deterministic run diagnostics: a machine-readable fact vector + engine-DERIVABLE flags
// for the LLM loop. The engine emits only what it can fully see (facts) and flags derivable from
// those facts + operator thresholds; lab-only judgments (suspected_overfit / hypothesis_mismatch)
// stay lab-side. Advisory: the result rides the summary projection only, never a hashed payload.

import type { RunDiagnostics, RunDiagnosticFlag } from '@trading-backtester/sdk/contracts';
import type { EquityPoint, Trade } from './artifacts.js';
import { quantize } from '../determinism/canonical-json.js';
import { dsrInputsFromEquity } from './metrics.js';

export interface RunDiagnosticsInput {
  readonly trades: readonly Trade[];
  readonly equity: readonly EquityPoint[];
  readonly barsProcessed: number;
  readonly orderCount: number;
  readonly policy: { readonly minTrades: number; readonly concentrationPct: number };
}

/** Deterministic fact vector + engine-derivable flags. All facts pure over trades/equity, quantized. */
export function computeRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  const { trades, equity, barsProcessed, orderCount, policy } = input;

  const tradeCount = trades.length;
  let winningTrades = 0;
  let losingTrades = 0;
  let exposureBars = 0;
  let grossProfit = 0;
  let maxWinner = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) {
      winningTrades += 1;
      grossProfit += t.realizedPnl;
      if (t.realizedPnl > maxWinner) maxWinner = t.realizedPnl;
    } else if (t.realizedPnl < 0) {
      losingTrades += 1;
    }
    exposureBars += t.exitBarIndex - t.entryBarIndex;
  }
  // Sums position-bars, so it MAY exceed 1 with concurrent positions (documented).
  const exposureFraction = barsProcessed > 0 ? exposureBars / barsProcessed : 0;
  const topTradeContributionPct = grossProfit > 0 ? (maxWinner / grossProfit) * 100 : 0;
  const returnsCount = dsrInputsFromEquity(equity)?.tCount ?? 0;

  const facts = {
    tradeCount: quantize(tradeCount),
    orderCount: quantize(orderCount),
    barsProcessed: quantize(barsProcessed),
    exposureFraction: quantize(exposureFraction),
    winningTrades: quantize(winningTrades),
    losingTrades: quantize(losingTrades),
    topTradeContributionPct: quantize(topTradeContributionPct),
    returnsCount: quantize(returnsCount),
  };

  // Stable, deterministic flag order.
  const flags: RunDiagnosticFlag[] = [];
  if (tradeCount === 0) flags.push('no_entries');
  if (tradeCount < policy.minTrades) flags.push('underpowered');
  if (grossProfit > 0 && topTradeContributionPct > policy.concentrationPct) {
    flags.push('single_trade_dominated');
  }
  if (exposureBars === 0) flags.push('zero_exposure');
  if (tradeCount > 0 && winningTrades === 0) flags.push('all_losing');

  return { facts, flags, policy };
}
