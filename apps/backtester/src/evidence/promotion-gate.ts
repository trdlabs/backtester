// E4b — pure promotion gate, split so the worker interleaves the epoch/coverage resolve between the two
// (canonical order gate→twin→holdout). No I/O — ledger/sign/resolver live in the worker (Task 7).
import { compareBacktestRuns } from '../engine/equivalence.js';
import { evaluateWindow, type CompletedOutcome } from '../engine/window-eval.js';
import { parseTimeframeMs } from '../engine/timeframe.js';
import { decideVerdict, type EvidenceThresholds } from './verdict.js';
import type { RunPeriod } from '@trading-backtester/sdk/contracts';

/** True iff SOME bar's interval [ts, ts+interval) contains wFrom (left edge covered by a real bar) AND some
 *  bar's interval reaches wTo (right edge covered). Inspects actual bars, so a hole at either boundary fails. */
function symbolCoversWindow(barTimes: readonly number[], wFrom: number, wTo: number, interval: number): boolean {
  let left = false;
  let right = false;
  for (const ts of barTimes) {
    if (ts <= wFrom && ts + interval > wFrom) left = true;
    if (ts < wTo && ts + interval >= wTo) right = true;
    if (left && right) return true;
  }
  return left && right;
}

export function evaluatePromotionIntegrity(input: {
  readonly candidate: CompletedOutcome; readonly curated: CompletedOutcome; readonly bundleGateRejected: boolean;
}): { outcome: 'ok' } | { outcome: 'reject'; reason: 'gate_rejected' | 'twin_divergent' } {
  if (input.bundleGateRejected) return { outcome: 'reject', reason: 'gate_rejected' };
  if (!compareBacktestRuns(input.curated, input.candidate).equivalent) return { outcome: 'reject', reason: 'twin_divergent' };
  return { outcome: 'ok' };
}

export function evaluatePromotionWindow(input: {
  readonly candidate: CompletedOutcome; readonly curated: CompletedOutcome;
  readonly holdoutWindow: RunPeriod;   // non-null: the worker handled holdout_unavailable already
  readonly runPeriod: RunPeriod; readonly thresholds: EvidenceThresholds;
  readonly policyMetrics: readonly string[]; readonly minWarmupBars: number; readonly minTrades: number;
  /** Per-symbol ACTUAL bar start-timestamps of the FROZEN executed tape + the TRUSTED request timeframe —
   *  inputs to the fail-closed completeness guard below. */
  readonly executedBarTimes: ReadonlyArray<readonly number[]>;
  readonly timeframe: string;
}):
  | { outcome: 'reject'; reason: 'holdout_not_covered' | 'warmup_insufficient' | 'evaluation_insufficient' }
  | { outcome: 'evaluated'; verdict: 'passed' | 'failed'; candidateHoldoutMetrics: Record<string, number>; curatedHoldoutMetrics: Record<string, number> } {
  const w = input.holdoutWindow;
  const wFrom = Date.parse(w.from), wTo = Date.parse(w.to);
  const pFrom = Date.parse(input.runPeriod.from), pTo = Date.parse(input.runPeriod.to);
  if (!(pFrom <= wFrom && wTo <= pTo)) return { outcome: 'reject', reason: 'holdout_not_covered' };
  // Completeness (fail-closed): for EVERY symbol the FROZEN executed tape must have an ACTUAL bar whose
  // interval covers the LEFT holdout edge AND an actual bar whose interval reaches the RIGHT edge. Checking
  // real bars (not just the [firstTs,lastTs] span) catches a hole AT a boundary; the grid step comes from
  // the TRUSTED request.timeframe (never inferred from bar spacing — a leading gap would inflate it and
  // mask a missing tail). Unknown timeframe, no symbols, or any uncovered boundary ⇒ evaluation_insufficient,
  // returned BEFORE the ledger write and signing — so a signed v2 evaluationWindow always matches the
  // executed range for every symbol.
  const interval = parseTimeframeMs(input.timeframe);
  const covered = interval !== null && input.executedBarTimes.length > 0 && input.executedBarTimes.every(
    (bars) => symbolCoversWindow(bars, wFrom, wTo, interval),
  );
  if (!covered) return { outcome: 'reject', reason: 'evaluation_insufficient' };
  const evalC = evaluateWindow(input.candidate, w, input.policyMetrics);
  if (evalC.warmupSteps < input.minWarmupBars) return { outcome: 'reject', reason: 'warmup_insufficient' };
  if (evalC.equity.length < 2 || evalC.inTest.length < input.minTrades) return { outcome: 'reject', reason: 'evaluation_insufficient' };
  const evalCur = evaluateWindow(input.curated, w, input.policyMetrics);
  const verdict = decideVerdict(evalC.metrics, input.thresholds);
  return { outcome: 'evaluated', verdict, candidateHoldoutMetrics: evalC.metrics, curatedHoldoutMetrics: evalCur.metrics };
}
