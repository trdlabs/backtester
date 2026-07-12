// E2 — finalize-time orchestrator: record this run as a trial and compute the advisory TrialContext
// (Deflated Sharpe + trial count N) from the family's history. Called flag-gated by the worker AFTER
// resultHash is computed; the returned context rides the RunResultSummary projection only.

import type { TrialContext } from '@trading-backtester/sdk/contracts';
import type { EquityPoint } from '../../engine/artifacts.js';
import { computeDsr } from '../../engine/deflated-sharpe.js';
import { dsrInputsFromEquity } from '../../engine/metrics.js';
import { computeFamilyKey, type FamilyKeyInput, type TrialLedger } from './trial-ledger.js';

export interface RecordTrialDeps {
  readonly ledger: TrialLedger;
  readonly empiricalMinN: number;
  readonly clock: () => number;
}

export interface RecordTrialInput {
  readonly request: FamilyKeyInput;
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly equity: readonly EquityPoint[];
}

/**
 * `null` (⇒ no trialContext) when the run is degenerate (`dsrInputsFromEquity` null: <2 returns or
 * std 0) or the DSR is undefined. Otherwise records the trial idempotently, then computes DSR over
 * all recorded family Sharpes (this run included).
 */
export async function recordTrialAndComputeContext(
  deps: RecordTrialDeps,
  input: RecordTrialInput,
): Promise<TrialContext | null> {
  const inputs = dsrInputsFromEquity(input.equity);
  if (inputs === null) return null;

  const familyKey = computeFamilyKey(input.request);
  await deps.ledger.recordIfNew({
    familyKey,
    requestFingerprint: input.requestFingerprint,
    runId: input.runId,
    resultHash: input.resultHash,
    trialFamilyHint: input.request.trialFamilyHint,
    marketContext: {
      datasetRef: input.request.datasetRef,
      symbols: input.request.symbols,
      timeframe: input.request.timeframe,
      period: input.request.period,
    },
    sharpe: inputs.sharpe,
    skew: inputs.skew,
    kurtosis: inputs.kurtosis,
    tCount: inputs.tCount,
    createdAtMs: deps.clock(),
  });

  const trials = await deps.ledger.query(familyKey);
  const dsr = computeDsr({
    sr: inputs.sharpe,
    skew: inputs.skew,
    kurtosis: inputs.kurtosis,
    T: inputs.tCount,
    priorSharpes: trials.map((t) => t.sharpe),
    empiricalMinN: deps.empiricalMinN,
  });
  if (dsr === null) return null;

  return {
    familyKey,
    familyHint: input.request.trialFamilyHint,
    trialCount: dsr.trialCount,
    deflatedSharpe: dsr.deflatedSharpe,
    sr0: dsr.sr0,
    vSR: dsr.vSR,
    vSRBasis: dsr.vSRBasis,
    tCount: dsr.tCount,
  };
}
