// E3b — pure walk-forward execution orchestrator. Splits the period (E3a), runs each fold via an
// injected runFold over [train.from, test.to], evaluates the TEST window post-hoc (anchored equity
// slice + fully-in-test trades + E1a computeMetrics), and reduces to a resolved|partial|unavailable
// status union. No I/O; runFold is the only side-effecting seam and it is injected. Advisory: the
// result rides the summary projection only, never fails the canonical run.

import type {
  RunPeriod, WalkForward, WalkForwardFailure, WalkForwardFailureCode, WalkForwardFoldResult,
  WalkForwardScheme, FoldWindow,
} from '@trdlabs/backtester-sdk/contracts';
import type { RunOutcome } from './artifacts.js';
import { aggregateFolds, splitWalkForward } from './walk-forward.js';
import { evaluateWindow } from './window-eval.js';

export type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>;

/** A fold execution failed with a classified reason. runFold throws this; an un-coded throw ⇒ runner_failure. */
export class WalkForwardFoldError extends Error {
  constructor(readonly code: WalkForwardFailureCode, message: string) {
    super(message);
    this.name = 'WalkForwardFoldError';
  }
}

export type RunFold = (fold: FoldWindow) => Promise<{ outcome: CompletedOutcome; hash: string }>;

export interface WalkForwardExecInput {
  readonly scheme: WalkForwardScheme;
  readonly period: RunPeriod;
  readonly requestedMetrics: readonly string[];
  readonly maxFolds: number;
  readonly deadlineExceeded: () => boolean;
}

export async function runWalkForward(input: WalkForwardExecInput, runFold: RunFold): Promise<WalkForward> {
  const { scheme, period, requestedMetrics, maxFolds, deadlineExceeded } = input;
  try {
    if (scheme.folds > maxFolds) {
      return { status: 'unavailable', scheme, reason: 'folds_exceeds_max', failedFolds: [], insufficientFolds: [] };
    }
    let windows: FoldWindow[];
    try {
      windows = splitWalkForward(period, scheme);
    } catch {
      return { status: 'unavailable', scheme, reason: 'split_error', failedFolds: [], insufficientFolds: [] };
    }

    const folds: WalkForwardFoldResult[] = [];
    const failedFolds: WalkForwardFailure[] = [];
    const insufficientFolds: number[] = [];
    let budgetCut = false;

    for (const fold of windows) {
      if (budgetCut || deadlineExceeded()) {
        budgetCut = true;
        failedFolds.push({ index: fold.index, code: 'budget_exhausted' });
        continue;
      }
      let ran: { outcome: CompletedOutcome; hash: string };
      try {
        ran = await runFold(fold);
      } catch (err) {
        const code = err instanceof WalkForwardFoldError ? err.code : 'runner_failure';
        failedFolds.push({ index: fold.index, code });
        continue;
      }
      const { equity, carryInClosedTradeCount, metrics } = evaluateWindow(ran.outcome, fold.test, requestedMetrics);
      if (equity.length < 2) {
        insufficientFolds.push(fold.index);
        continue;
      }
      folds.push({ index: fold.index, train: fold.train, test: fold.test, foldOutcomeHash: ran.hash, metrics, carryInClosedTradeCount });
    }

    if (folds.length === 0) {
      const reason = failedFolds.length > 0 ? 'all_folds_failed' : 'insufficient_folds';
      return { status: 'unavailable', scheme, reason, failedFolds, insufficientFolds };
    }
    const agg = aggregateFolds(folds.map((f) => ({ index: f.index, metrics: f.metrics })));
    const aggregate = { ...agg, requestedFoldCount: scheme.folds, completedFoldCount: folds.length, insufficientFolds };
    const status = folds.length === scheme.folds ? 'resolved' : 'partial';
    return { status, scheme, folds, aggregate, failedFolds };
  } catch {
    return { status: 'unavailable', scheme, reason: 'internal_error', failedFolds: [], insufficientFolds: [] };
  }
}
