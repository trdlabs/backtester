// E4b — pure promotion gate, split so the worker interleaves the epoch/coverage resolve between the two
// (canonical order gate→twin→holdout). No I/O — ledger/sign/resolver live in the worker (Task 7).
import { compareBacktestRuns } from '../engine/equivalence.js';
import { evaluateWindow, type CompletedOutcome } from '../engine/window-eval.js';
import { parseTimeframeMs } from '../engine/timeframe.js';
import { decideVerdict, type EvidenceThresholds } from './verdict.js';
import type { RunPeriod } from '@trdlabs/backtester-sdk/contracts';

/** True iff the tape FULLY and CONTIGUOUSLY covers the holdout window `[wFrom, wTo)` on the trusted grid:
 *  a real bar covering the left edge, then every `interval`-spaced slot present up to `wTo`, and NO extra
 *  in-window bars (which would mean the declared timeframe is coarser than the real cadence). This catches
 *  a hole at either boundary, an INTERIOR gap, and a declared-vs-actual cadence mismatch — so the signed
 *  evaluationWindow can never claim a span the executed tape didn't fully cover. */
function symbolCoversWindow(barTimes: readonly number[], wFrom: number, wTo: number, interval: number): boolean {
  const present = new Set(barTimes);
  // The bar whose half-open interval [anchor, anchor+interval) contains wFrom — the grid phase + left edge.
  let anchor: number | undefined;
  for (const ts of barTimes) {
    if (ts <= wFrom && ts + interval > wFrom && (anchor === undefined || ts > anchor)) anchor = ts;
  }
  if (anchor === undefined) return false; // left edge uncovered
  // Walk the grid from the anchor to wTo; every in-window slot must be a real bar (contiguity → interior +
  // tail coverage). Counting the slots also lets us reject EXTRA in-window bars below (coarse-cadence trap).
  let expected = 0;
  for (let ts = anchor; ts < wTo; ts += interval) {
    if (ts >= wFrom) {
      expected += 1;
      if (!present.has(ts)) return false; // interior or tail gap on the trusted grid
    }
  }
  // No extra in-window bars: declared interval coarser than the real cadence would leave more actual bars
  // in [wFrom, wTo) than grid slots. Equality ⇒ the tape's cadence matches the trusted timeframe.
  let actualInWindow = 0;
  for (const ts of barTimes) if (ts >= wFrom && ts < wTo) actualInWindow += 1;
  return actualInWindow === expected;
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
  /** Per-symbol ACTUAL bar start-timestamps of the FROZEN executed tape. */
  readonly executedBarTimes: ReadonlyArray<readonly number[]>;
  /** The client-declared timeframe (untrusted — submit only checks it's a non-empty string). */
  readonly requestTimeframe: string;
  /** The SERVER-derived dataset timeframe, frozen with coverage. The grid is built from THIS, and the
   *  request must equal it — otherwise a client could relabel a sparse fine tape as a coarse one to fake
   *  full coverage (bars at 6d,8d "cover" [6d,10d) if you claim '2d'). */
  readonly datasetTimeframe: string;
}):
  | { outcome: 'reject'; reason: 'holdout_not_covered' | 'warmup_insufficient' | 'evaluation_insufficient' }
  | { outcome: 'evaluated'; verdict: 'passed' | 'failed'; candidateHoldoutMetrics: Record<string, number>; curatedHoldoutMetrics: Record<string, number> } {
  const w = input.holdoutWindow;
  const wFrom = Date.parse(w.from), wTo = Date.parse(w.to);
  const pFrom = Date.parse(input.runPeriod.from), pTo = Date.parse(input.runPeriod.to);
  if (!(pFrom <= wFrom && wTo <= pTo)) return { outcome: 'reject', reason: 'holdout_not_covered' };
  // Completeness (fail-closed): for EVERY symbol the FROZEN executed tape must FULLY and CONTIGUOUSLY cover
  // the holdout window on the trusted grid — a real bar at the left edge, every interval-spaced slot present
  // through wTo (no interior or tail gap), and NO extra in-window bars (which would mean the declared
  // timeframe is coarser than the real cadence). The grid step is parsed from the TRUSTED request.timeframe
  // (never inferred from bar spacing — a leading gap would inflate it and mask a missing tail). Unknown
  // timeframe, no symbols, or any incomplete symbol ⇒ evaluation_insufficient, returned BEFORE the ledger
  // write and signing — so a signed v2 evaluationWindow can never claim a span the tape didn't fully cover.
  // The request timeframe must equal the SERVER-derived dataset timeframe, and the grid is built from the
  // server value (never the client's). A mismatch means the client relabeled the data (e.g. calling a 1m
  // dataset '2d' so a sparse 6d/8d tape looks like full 2d coverage) — fail closed.
  const interval = input.requestTimeframe === input.datasetTimeframe ? parseTimeframeMs(input.datasetTimeframe) : null;
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
