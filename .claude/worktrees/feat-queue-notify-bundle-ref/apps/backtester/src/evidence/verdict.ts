// Verdict gate: passed iff the run clears every threshold, computed from REAL backtest metrics.
// Conservative floor only — a real product gate is calibrated from operational experience.
// TODO(product): replace these floors with calibrated thresholds once we have production data.
//   Hardcoding arbitrary numbers now would look intentional and get copied unverified.

export interface EvidenceThresholds {
  readonly minSharpe: number;    // strict >  (per-bar Sharpe; > 0 = "edge, not noise")
  readonly maxDrawdown: number;  // strict <  (fraction; 1 = 100% = blew up)
  readonly minWinRate: number;   // strict >  (fraction; > 0 = won at least once)
  readonly minTrades: number;    // >=        (at least one closed trade)
}

export const DEFAULT_THRESHOLDS: EvidenceThresholds = {
  minSharpe: 0,
  maxDrawdown: 1,
  minWinRate: 0,
  minTrades: 1,
};

/** Missing metric ⇒ failed (conservative). Metric names match engine computeMetrics output. */
export function decideVerdict(
  metrics: Readonly<Record<string, number | undefined>>,
  thresholds: EvidenceThresholds = DEFAULT_THRESHOLDS,
): 'passed' | 'failed' {
  const sharpe = metrics.sharpe;
  const drawdown = metrics.max_drawdown;
  const winRate = metrics.win_rate;
  const trades = metrics.total_trades;
  if (sharpe === undefined || drawdown === undefined || winRate === undefined || trades === undefined) {
    return 'failed';
  }
  const ok =
    sharpe > thresholds.minSharpe &&
    drawdown < thresholds.maxDrawdown &&
    winRate > thresholds.minWinRate &&
    trades >= thresholds.minTrades;
  return ok ? 'passed' : 'failed';
}
