// Slice 6a — project a completed overlay RunOutcome to the wire RunResultSummary.
//
// The engine RunOutcome (artifacts.ts) carries baseline/variant BacktestRunResults plus an optional
// ComparisonSummary. The wire summary the HTTP API emits is RunResultSummary (research-contracts). The
// headline target is the variant when an overlay ran, else the baseline. `comparison` is OMITTED (not
// set to null) when absent, so non-overlay results share the exact wire shape with momentum summaries.

import type { RunResultSummary, RunEvidence, ArtifactReference, ContentHash } from '@trading/research-contracts';
import { CONTRACT_VERSION } from '@trading/research-contracts';
import type { RunOutcome } from '../engine/artifacts';

/** Project a completed overlay RunOutcome to the wire RunResultSummary. */
export function toOverlaySummary(
  outcome: Extract<RunOutcome, { status: 'completed' }>,
  runId: string,
  artifactRefs: readonly ArtifactReference[],
  resultHash: ContentHash,
  datasetFingerprint: string,
  bundleHash?: ContentHash,
  evidenceRef?: ArtifactReference,
): RunResultSummary {
  const headline = outcome.variant ?? outcome.baseline;
  const evidence: RunEvidence = {
    seed: headline.evidence.seed,
    contractVersion: CONTRACT_VERSION,
    moduleVersions: headline.evidence.moduleVersions,
    datasetRef: headline.evidence.datasetRef,
    datasetFingerprint,
    ...(bundleHash !== undefined ? { bundleHash } : {}),
  };
  return {
    runId,
    status: 'completed',
    metrics: headline.metrics,
    artifactRefs,
    evidence,
    resultHash,
    ...(outcome.comparison != null ? { comparison: outcome.comparison } : {}),
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
  };
}
