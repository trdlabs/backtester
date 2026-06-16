// Run / result / artifact contract types (017 + 022 surface, MVP subset).
//
// These are the wire vocabulary the backtester HTTP API accepts and emits, and the eventual
// trading-lab `backtesterClient` consumes. Kept as pure types (no runtime deps) so this package is
// the single versioned parity anchor.

export type RunMode = 'research' | 'review' | 'promotion';

export interface Ref {
  readonly id: string;
  readonly version: string;
}

export interface RunPeriod {
  readonly from: string; // ISO-8601 UTC
  readonly to: string; // ISO-8601 UTC
}

export type ModuleKind = 'strategy';

/** Manifest of a submitted module. Identity is `id@version`; the registry key is the content hash. */
export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly bundleContractVersion: string;
}

/**
 * A self-contained, untrusted strategy module submitted for backtest. `files[entry]` is ESM source
 * exporting `signals(candles, seed): boolean[]`. Addressed and stored by content hash (`bundleHash`)
 * in the backtester's own registry — never shared with the platform on the execution path (ADR §12.5).
 */
export interface ModuleBundle {
  readonly manifest: ModuleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Canonical, self-contained backtest run request consumed by the runner. */
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
}

/** Gateway submit DTO: the run request plus orchestration fields (not part of the fingerprint). */
export interface RunSubmitRequest extends Omit<BacktestRunRequest, 'runId'> {
  /** Optional — server generates one when absent. */
  readonly runId?: string;
  /** When present, the run executes this untrusted bundle in the sandbox instead of the trusted runner. */
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
  /** Content hash of the executed bundle (sandboxed runs only); absent for the trusted runner. */
  readonly bundleHash?: ContentHash;
}

export interface RunResultSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly metrics: Record<string, number>;
  readonly artifactRefs: readonly ArtifactReference[];
  readonly evidence: RunEvidence;
  /** sha256 of canonicalJson(result) — the verifiable determinism/parity primitive. */
  readonly resultHash?: ContentHash;
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

/** The payload POSTed to a run's callback URL (and the durable outbox row) on a terminal transition. */
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

// ---- validation -------------------------------------------------------------

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

// ---- capability / dataset discovery ----------------------------------------

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
