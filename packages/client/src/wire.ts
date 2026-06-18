// Vendored copy of the backtester wire types (the subset of @trading/research-contracts the client's
// API surfaces). Vendored — NOT imported — so the built dist is self-contained and installs from
// git/path with no workspace resolution. Drift from @trading/research-contracts is caught at compile
// time by apps/backtester/test/client-parity.test.ts (mutual type assignability). Keep in sync.

export type RunMode = 'research' | 'review' | 'promotion';

export interface Ref {
  readonly id: string;
  readonly version: string;
}

export interface RunPeriod {
  readonly from: string;
  readonly to: string;
}

export type ModuleKind = 'strategy' | 'overlay';

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly bundleContractVersion: string;
}

export interface ModuleBundle {
  readonly manifest: ModuleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

export type BacktestEngine = 'momentum' | 'overlay';

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
}

export type NonTerminalRunStatus = 'accepted' | 'queued' | 'running';
export type TerminalRunStatus = 'completed' | 'failed' | 'canceled' | 'expired' | 'timed_out';
export type RunStatus = NonTerminalRunStatus | TerminalRunStatus;

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

export type ContentHash = `sha256:${string}`;
export type ArtifactAvailability = 'available' | 'unavailable' | 'not_applicable';

export interface ArtifactReference {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly availability: ArtifactAvailability;
  readonly approxItemCount?: number;
}

export interface ArtifactDescriptor {
  readonly artifactType: string;
  readonly contentHash: ContentHash;
  readonly availability: ArtifactAvailability;
  readonly approxItemCount?: number;
}

export interface ArtifactManifest {
  readonly runId: string;
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly descriptors: readonly ArtifactDescriptor[];
}

export interface ArtifactPage {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly page: readonly unknown[];
  readonly total: number;
  readonly offset: number;
  readonly nextCursor?: string;
}

export interface RunEvidence {
  readonly seed: number;
  readonly contractVersion: string;
  readonly moduleVersions: readonly Ref[];
  readonly datasetRef: string;
  readonly datasetFingerprint?: string;
  readonly bundleHash?: ContentHash;
}

// Vendored copy of the comparison wire vocabulary (mirrors @trading/research-contracts
// comparison.ts). Structurally identical so the optional RunResultSummary.comparison field stays
// assignable across the parity guard.
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
  /** Real baseline-vs-variant comparison (overlay-engine runs only; omitted for single-run/momentum summaries). */
  readonly comparison?: ComparisonSummary;
}

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

export type GatewayErrorCategory =
  | 'validation_error'
  | 'missing_dataset'
  | 'unsupported_data_needs'
  | 'sandbox_module_error'
  | 'runner_failure'
  | 'internal_gateway_error';

export interface GatewayError {
  readonly category: GatewayErrorCategory;
  readonly code: string;
  readonly message: string;
}

export type ValidationStatus = 'accepted' | 'accepted_with_warnings' | 'rejected';

export interface ValidationIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path?: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly status: ValidationStatus;
  readonly issues: readonly ValidationIssue[];
  readonly executed: false;
}

export interface CapabilityDescriptor {
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly supportedMetrics: readonly string[];
  readonly supportedModes: readonly RunMode[];
  readonly maxConcurrency: number;
}

export interface DatasetDescriptor {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly rowCount: number;
}

// Version constants (kept in lockstep with @trading/research-contracts).
export const CONTRACT_VERSION = '017.2';
export const ARTIFACT_CONTRACT_VERSION = '022.1';
export const BUNDLE_CONTRACT_VERSION = '019.1';
export const HISTORICAL_DATA_CONTRACT_VERSION = '030.1';
