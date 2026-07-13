// E3b/E4b — pure window evaluation: anchored equity slice + fully-in-test trade filter + computeMetrics
// over a [from, to) window of a completed outcome. Extracted so both walk-forward folds (E3b) and the
// held-out promotion gate (E4b) share one implementation.

import type { EquityPoint, RunOutcome, Trade } from './artifacts.js';
import { computeMetrics } from './metrics.js';

export type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Anchored test-window equity: last point with barTs < fromMs (boundary anchor) + points in [fromMs, toMs). */
export function anchoredTestEquity(equity: readonly EquityPoint[], fromMs: number, toMs: number): EquityPoint[] {
  const within = equity.filter((p) => p.barTs >= fromMs && p.barTs < toMs);
  let anchor: EquityPoint | undefined;
  for (const p of equity) if (p.barTs < fromMs && (anchor === undefined || p.barTs > anchor.barTs)) anchor = p;
  return anchor ? [anchor, ...within] : within;
}

export function evaluateWindow(
  outcome: CompletedOutcome,
  window: { from: string; to: string },
  requestedMetrics: readonly string[],
): { equity: EquityPoint[]; inTest: Trade[]; carryInClosedTradeCount: number; metrics: Record<string, number>; warmupSteps: number } {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const allEquity = outcome.baseline.evidence.equityCurve;
  const equity = anchoredTestEquity(allEquity, fromMs, toMs);
  // DISTINCT engine timestamps before the window (multi-symbol tape can emit several equity points per
  // barTs — one engine step). Count distinct barTs, NOT raw point count.
  const warmupSteps = new Set(allEquity.filter((p) => p.barTs < fromMs).map((p) => p.barTs)).size;
  const allTrades = outcome.baseline.trades;
  const inTest = allTrades.filter((t: Trade) => t.entryTs >= fromMs && t.exitTs < toMs);
  const carryInClosedTradeCount = allTrades.filter(
    (t: Trade) => t.entryTs < fromMs && t.exitTs >= fromMs && t.exitTs < toMs,
  ).length;
  const metrics = computeMetrics(requestedMetrics, equity, inTest, { elapsedYears: (toMs - fromMs) / YEAR_MS });
  return { equity, inTest, carryInClosedTradeCount, metrics, warmupSteps };
}
