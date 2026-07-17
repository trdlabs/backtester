// E4b — build the flat backtest-evidence/v2 promotion body (v1 fields + held-out binding). Signed only
// when verdict === 'passed', so this builder hardcodes verdict:'passed'.
import type { EvidenceBodyV2 } from '@trdlabs/backtester-sdk/contracts';

export function buildEvidenceBodyV2(input: {
  readonly backtesterRunId: string; readonly bundleHash: string; readonly keyId: string;
  readonly datasetRef: string; readonly executionWindow: { fromMs: number; toMs: number };
  readonly symbols: readonly string[]; readonly timeframe: string;
  readonly evaluationWindow: { fromMs: number; toMs: number };
  readonly candidateHoldoutMetrics: Record<string, number>; readonly curatedHoldoutMetrics: Record<string, number>;
  readonly thresholds: EvidenceBodyV2['thresholds']; readonly attemptNumber: number; readonly qualificationEpochKey: string;
  readonly candidateResultHash: string; readonly curatedResultHash: string;
  readonly curatedBaselineRef: { readonly id: string; readonly version: string };
  readonly qualification: EvidenceBodyV2['qualification'];
}): EvidenceBodyV2 {
  return {
    schema: 'backtest-evidence/v2',
    backtesterRunId: input.backtesterRunId,
    bundleHash: input.bundleHash,
    verdict: 'passed',
    datasetRef: input.datasetRef,
    window: input.executionWindow,
    symbols: [...input.symbols].sort(),
    timeframe: input.timeframe,
    keyId: input.keyId,
    mode: 'promotion',
    evaluationWindow: input.evaluationWindow,
    candidateHoldoutMetrics: input.candidateHoldoutMetrics,
    curatedHoldoutMetrics: input.curatedHoldoutMetrics,
    thresholds: input.thresholds,
    attemptNumber: input.attemptNumber,
    qualificationEpochKey: input.qualificationEpochKey,
    candidateResultHash: input.candidateResultHash,
    curatedResultHash: input.curatedResultHash,
    curatedBaselineRef: `${input.curatedBaselineRef.id}@${input.curatedBaselineRef.version}`,
    qualification: input.qualification,
  };
}
