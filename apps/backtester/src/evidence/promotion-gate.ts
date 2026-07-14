// E4b — pure promotion gate, split so the worker interleaves the epoch/coverage resolve between the two
// (canonical order gate→twin→holdout). No I/O — ledger/sign/resolver live in the worker (Task 7).
import { compareBacktestRuns } from '../engine/equivalence.js';
import { evaluateWindow, type CompletedOutcome } from '../engine/window-eval.js';
import { decideVerdict, type EvidenceThresholds } from './verdict.js';
import type { RunPeriod } from '@trading-backtester/sdk/contracts';

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
}):
  | { outcome: 'reject'; reason: 'holdout_not_covered' | 'warmup_insufficient' | 'evaluation_insufficient' }
  | { outcome: 'evaluated'; verdict: 'passed' | 'failed'; candidateHoldoutMetrics: Record<string, number>; curatedHoldoutMetrics: Record<string, number> } {
  const w = input.holdoutWindow;
  const wFrom = Date.parse(w.from), wTo = Date.parse(w.to);
  const pFrom = Date.parse(input.runPeriod.from), pTo = Date.parse(input.runPeriod.to);
  if (!(pFrom <= wFrom && wTo <= pTo)) return { outcome: 'reject', reason: 'holdout_not_covered' };
  const evalC = evaluateWindow(input.candidate, w, input.policyMetrics);
  if (evalC.warmupSteps < input.minWarmupBars) return { outcome: 'reject', reason: 'warmup_insufficient' };
  if (evalC.equity.length < 2 || evalC.inTest.length < input.minTrades) return { outcome: 'reject', reason: 'evaluation_insufficient' };
  const evalCur = evaluateWindow(input.curated, w, input.policyMetrics);
  const verdict = decideVerdict(evalC.metrics, input.thresholds);
  return { outcome: 'evaluated', verdict, candidateHoldoutMetrics: evalC.metrics, curatedHoldoutMetrics: evalCur.metrics };
}
