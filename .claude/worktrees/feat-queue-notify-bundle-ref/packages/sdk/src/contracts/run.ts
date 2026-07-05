import type { ContentHash } from '../internal/shared-types';
import type { ArtifactReference } from '../artifacts/types';
import type { BacktestEngine, ModuleBundle, ModuleKind, ModuleManifest } from './module';

export type { ModuleKind, ModuleManifest, ModuleBundle, BacktestEngine };

export type RunMode = 'research' | 'review' | 'promotion';

export interface Ref {
  readonly id: string;
  readonly version: string;
}

export interface RunPeriod {
  readonly from: string;
  readonly to: string;
}

export interface BacktestRunRequest {
  readonly runId: string;
  readonly mode: RunMode;
  readonly moduleRef: Ref;
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly params?: Record<string, unknown>;
  readonly seed: number;
  readonly metrics: readonly string[];
  readonly overlayRefs?: readonly Ref[];
  readonly riskProfileRef?: Ref;
  readonly executionProfileRef?: Ref;
  readonly parameterGrid?: object;
  readonly robustnessChecks?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly engine?: BacktestEngine;
  /** Backtester-only: trusted baseline ref to compare against for signed evidence (e.g. short_after_pump). Stripped before the lifted runner; never reaches the 017 validator. */
  readonly curatedBaselineRef?: Ref;
}

export interface ModuleValidateRequest {
  readonly moduleBundle?: ModuleBundle;
  readonly engine?: BacktestEngine;
}

export interface RunSubmitRequest extends Omit<BacktestRunRequest, 'runId'> {
  readonly runId?: string;
  readonly moduleBundle?: ModuleBundle;
  readonly resumeToken?: string;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly callbackUrl?: string;
  readonly queueTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  /** Force a fresh compute, bypassing the result-dedup cache. Not run-affecting (excluded from the
   *  fingerprint); a bypassed run still populates the cache on completion. */
  readonly bypassCache?: boolean;
}

export interface RunJobHandle {
  readonly jobId: string;
  readonly runId: string;
  readonly status: 'accepted';
  readonly effectiveSeed: number;
  readonly requestFingerprint: string;
  readonly idempotentReplay: boolean;
  readonly correlationId?: string;
  readonly workflowId?: string;
}

export type NonTerminalRunStatus = 'accepted' | 'queued' | 'running';
export type TerminalRunStatus = 'completed' | 'failed' | 'canceled' | 'expired' | 'timed_out';
export type RunStatus = NonTerminalRunStatus | TerminalRunStatus;

export interface RunTimelineEntry {
  readonly status: RunStatus;
  readonly atMs: number;
}

export interface RunStatusView {
  readonly runId: string;
  readonly jobId: string;
  readonly status: RunStatus;
  readonly timeline: readonly RunTimelineEntry[];
  readonly terminalCode?: string;
}

export interface RunEvidence {
  readonly seed: number;
  readonly contractVersion: string;
  readonly moduleVersions: readonly Ref[];
  readonly datasetRef: string;
  readonly datasetFingerprint?: string;
  readonly bundleHash?: ContentHash;
}

export interface MetricDelta {
  readonly baseline: number;
  readonly variant: number;
  readonly delta: number;
}

export interface OverlayEffectsSummary {
  readonly pass: number;
  readonly annotate: number;
  readonly patch: number;
  readonly veto: number;
}

export interface ComparisonVariant {
  readonly runId: string;
  readonly overlayRefs: readonly Ref[];
  readonly metricDeltas: Readonly<Record<string, MetricDelta>>;
  readonly tradeOutcomeChanged: boolean;
  readonly overlayEffectsSummary: OverlayEffectsSummary;
}

export interface ComparisonSummary {
  readonly baselineRunId: string;
  readonly variants: readonly ComparisonVariant[];
}

export interface RunResultSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly metrics: Record<string, number>;
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidence: RunEvidence;
  readonly resultHash?: ContentHash;
  readonly comparison?: ComparisonSummary;
  /** Pointer to the signed backtest-evidence/v1 artifact in the ArtifactStore (present only when evidence was produced). */
  readonly evidenceRef?: ArtifactReference;
}

export type CompletionEventType =
  | 'job_completed'
  | 'job_failed'
  | 'job_canceled'
  | 'job_expired'
  | 'job_timed_out';

export interface CompletionEvent {
  readonly eventType: CompletionEventType;
  readonly jobId: string;
  readonly runId: string;
  readonly status: TerminalRunStatus;
  readonly correlationId?: string;
  readonly workflowId?: string;
  readonly summary: RunResultSummary;
  readonly emittedAtMs: number;
}
