// Slice 6a — overlay artifact persistence. Mirrors persistRunArtifacts (store.ts) but sources the
// specs from a completed engine RunOutcome instead of a momentum BacktestResult. Headline target is
// the variant when an overlay ran, else the baseline. The `comparison` spec is persisted ONLY when
// the outcome carries a non-null ComparisonSummary (baseline-only runs skip it entirely).

import type {
  ArtifactDescriptor,
  ArtifactReference,
} from '@trading-backtester/sdk/artifacts';
import { API_CONTRACT_VERSION, ARTIFACT_CONTRACT_VERSION } from '@trading-backtester/sdk/contracts';
import type { ArtifactStore, PersistedArtifacts } from './store';
import type { RunOutcome } from '../engine/artifacts';

interface ArtifactSpec {
  readonly artifactType: string;
  readonly payload: unknown;
  readonly itemCount?: number;
}

/** Artifact type for the baseline leg's per-trade records on a comparison run (slice 1b). */
export const BASELINE_TRADES = 'baseline-trades' as const;

/** Build, write, and describe the per-run artifacts for a completed overlay RunOutcome. */
export async function persistOverlayArtifacts(
  store: ArtifactStore,
  outcome: Extract<RunOutcome, { status: 'completed' }>,
  datasetFingerprint: string,
): Promise<PersistedArtifacts> {
  const headline = outcome.variant ?? outcome.baseline;

  const specs: ArtifactSpec[] = [
    {
      artifactType: 'run-summary',
      payload: {
        runId: headline.runId,
        status: 'completed',
        runKind: 'overlay',
        metrics: headline.metrics,
        evidence: { ...headline.evidence, datasetFingerprint },
        ...(outcome.comparison != null ? { comparison: outcome.comparison } : {}),
      },
    },
    { artifactType: 'metrics', payload: headline.metrics },
    { artifactType: 'trades', payload: headline.trades, itemCount: headline.trades.length },
    {
      artifactType: 'decision-records',
      payload: headline.decisionRecords,
      itemCount: headline.decisionRecords.length,
    },
    ...(outcome.comparison != null
      ? [
          { artifactType: 'comparison', payload: outcome.comparison } satisfies ArtifactSpec,
          {
            artifactType: BASELINE_TRADES,
            payload: outcome.baseline.trades,
            itemCount: outcome.baseline.trades.length,
          } satisfies ArtifactSpec,
        ]
      : []),
  ];

  const descriptors: ArtifactDescriptor[] = [];
  const artifactRefs: ArtifactReference[] = [];
  for (const spec of [...specs].sort((a, b) => a.artifactType.localeCompare(b.artifactType))) {
    const contentHash = await store.write(spec.payload);
    descriptors.push({
      artifactType: spec.artifactType,
      contentHash,
      availability: 'available',
      ...(spec.itemCount !== undefined ? { approxItemCount: spec.itemCount } : {}),
    });
    artifactRefs.push({
      artifactId: contentHash,
      artifactType: spec.artifactType,
      availability: 'available',
      ...(spec.itemCount !== undefined ? { approxItemCount: spec.itemCount } : {}),
    });
  }

  return {
    manifest: {
      runId: headline.runId,
      contractVersion: API_CONTRACT_VERSION,
      artifactContractVersion: ARTIFACT_CONTRACT_VERSION,
      descriptors,
    },
    artifactRefs,
  };
}
