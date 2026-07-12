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

// E3a — walk-forward substrate types. Exported as the shared contract; NOT yet wired into any
// request/result (server-side per-fold execution is E3b). Fold windows reuse RunPeriod.
export interface WalkForwardScheme {
  readonly folds: number;
  readonly mode: 'rolling' | 'expanding';
}
export interface FoldWindow {
  readonly index: number;
  readonly train: RunPeriod;
  readonly test: RunPeriod;
}
export interface WalkForwardFoldMetrics {
  readonly index: number;
  readonly metrics: Record<string, number>;
}
export interface WalkForwardMetricStats {
  readonly mean: number;
  /** Population standard deviation (consistency with E1a; robust at small fold counts). */
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  /** Fraction of folds with value > 0. */
  readonly positiveFraction: number;
}
export interface WalkForwardAggregate {
  readonly foldCount: number;
  readonly metrics: Record<string, WalkForwardMetricStats>;
}

// E4a — held-out OOS qualification marker (advisory; NOT part of the hashed result). A run's
// `holdout` marker records whether the run touched the server-reserved OOS window, with provenance
// (the window drifts as coverage grows). Present only when BACKTESTER_HOLDOUT_ENABLED.
export interface HoldoutResolved {
  readonly status: 'resolved';
  readonly policy: 'coverage_fraction';
  readonly fraction: number;
  /** Coverage span the window was carved from (provenance — the window moves as coverage grows). */
  readonly coverage: RunPeriod;
  readonly window: RunPeriod;
  readonly overlaps: boolean;
  /** 'full' = run entirely INSIDE the holdout (run ⊆ holdout), NOT "run covered the whole holdout". */
  readonly containment: 'none' | 'partial' | 'full';
}
export interface HoldoutUnknown {
  readonly status: 'unknown';
  readonly reason: 'coverage_not_found';
}
export type HoldoutMarker = HoldoutResolved | HoldoutUnknown;

// E1b — structured run diagnostics (advisory; NOT part of the hashed result). Machine-readable facts
// the engine can fully see + flags DERIVABLE from those facts + operator thresholds. Lab-only
// judgments (suspected_overfit / hypothesis_mismatch) are NOT emitted here.
export type RunDiagnosticFlag =
  | 'no_entries'
  | 'underpowered'
  | 'single_trade_dominated'
  | 'zero_exposure'
  | 'all_losing';
export interface RunDiagnostics {
  readonly facts: {
    readonly tradeCount: number;
    readonly orderCount: number;
    readonly barsProcessed: number;
    /** Position-bars / total bars; MAY exceed 1 with concurrent positions. */
    readonly exposureFraction: number;
    readonly winningTrades: number;
    readonly losingTrades: number;
    readonly topTradeContributionPct: number;
    readonly returnsCount: number;
  };
  readonly flags: readonly RunDiagnosticFlag[];
  /** Operator thresholds that produced the flags (provenance). */
  readonly policy: { readonly minTrades: number; readonly concentrationPct: number };
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
  /** E2: lab-supplied hypothesis-family hint (family-identity layer L1). Groups trials for the
   *  Deflated Sharpe trial count N; advisory, NOT part of `requestFingerprint`. Falls back to
   *  `moduleRef.id` server-side when absent. */
  readonly trialFamilyHint?: string;
}

export interface ModuleValidateRequest {
  readonly moduleBundle?: ModuleBundle;
  readonly engine?: BacktestEngine;
}

export interface RunSubmitRequest extends Omit<BacktestRunRequest, 'runId'> {
  readonly runId?: string;
  readonly moduleBundle?: ModuleBundle;
  /** Content hash of a bundle already uploaded via POST /v1/bundles. Mutually exclusive with moduleBundle. */
  readonly bundleRef?: ContentHash;
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

/**
 * E2: advisory Deflated Sharpe Ratio + trial provenance. NEVER part of the hashed result payload —
 * DSR depends on the family's trial history (stateful), so it lives on this projection only and is
 * present solely when the trial ledger is enabled (`BACKTESTER_TRIAL_LEDGER`).
 */
export interface TrialContext {
  readonly familyKey: string;
  readonly familyHint?: string;
  readonly trialCount: number;
  readonly deflatedSharpe: number;
  readonly sr0: number;
  readonly vSR: number;
  readonly vSRBasis: 'asymptotic' | 'empirical';
  readonly tCount: number;
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
  /** E2: advisory trial count + Deflated Sharpe; NOT covered by `resultHash`. */
  readonly trialContext?: TrialContext;
  /** E4a: advisory held-out OOS qualification marker; NOT covered by `resultHash`. */
  readonly holdout?: HoldoutMarker;
  /** E1b: advisory structured run diagnostics (facts + flags); NOT covered by `resultHash`. */
  readonly diagnostics?: RunDiagnostics;
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
