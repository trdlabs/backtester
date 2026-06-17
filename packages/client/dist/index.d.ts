type RunMode = 'research' | 'review' | 'promotion';
interface Ref {
    readonly id: string;
    readonly version: string;
}
interface RunPeriod {
    readonly from: string;
    readonly to: string;
}
type ModuleKind = 'strategy';
interface ModuleManifest {
    readonly id: string;
    readonly version: string;
    readonly kind: ModuleKind;
    readonly bundleContractVersion: string;
}
interface ModuleBundle {
    readonly manifest: ModuleManifest;
    readonly entry: string;
    readonly files: Readonly<Record<string, string>>;
}
interface BacktestRunRequest {
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
interface RunSubmitRequest extends Omit<BacktestRunRequest, 'runId'> {
    readonly runId?: string;
    readonly moduleBundle?: ModuleBundle;
    readonly resumeToken?: string;
    readonly correlationId?: string;
    readonly workflowId?: string;
    readonly callbackUrl?: string;
    readonly queueTimeoutMs?: number;
    readonly runTimeoutMs?: number;
}
type NonTerminalRunStatus = 'accepted' | 'queued' | 'running';
type TerminalRunStatus = 'completed' | 'failed' | 'canceled' | 'expired' | 'timed_out';
type RunStatus = NonTerminalRunStatus | TerminalRunStatus;
interface RunJobHandle {
    readonly jobId: string;
    readonly runId: string;
    readonly status: 'accepted';
    readonly effectiveSeed: number;
    readonly requestFingerprint: string;
    readonly idempotentReplay: boolean;
    readonly correlationId?: string;
    readonly workflowId?: string;
}
type ContentHash = `sha256:${string}`;
type ArtifactAvailability = 'available' | 'unavailable' | 'not_applicable';
interface ArtifactReference {
    readonly artifactId: ContentHash;
    readonly artifactType: string;
    readonly availability: ArtifactAvailability;
    readonly approxItemCount?: number;
}
interface ArtifactDescriptor {
    readonly artifactType: string;
    readonly contentHash: ContentHash;
    readonly availability: ArtifactAvailability;
    readonly approxItemCount?: number;
}
interface ArtifactManifest {
    readonly runId: string;
    readonly contractVersion: string;
    readonly artifactContractVersion: string;
    readonly descriptors: readonly ArtifactDescriptor[];
}
interface ArtifactPage {
    readonly artifactId: ContentHash;
    readonly artifactType: string;
    readonly page: readonly unknown[];
    readonly total: number;
    readonly offset: number;
    readonly nextCursor?: string;
}
interface RunEvidence {
    readonly seed: number;
    readonly contractVersion: string;
    readonly moduleVersions: readonly Ref[];
    readonly datasetRef: string;
    readonly datasetFingerprint?: string;
    readonly bundleHash?: ContentHash;
}
interface RunResultSummary {
    readonly runId: string;
    readonly status: RunStatus;
    readonly metrics: Record<string, number>;
    readonly artifactRefs: readonly ArtifactReference[];
    readonly evidence: RunEvidence;
    readonly resultHash?: ContentHash;
}
interface RunTimelineEntry {
    readonly status: RunStatus;
    readonly atMs: number;
}
interface RunStatusView {
    readonly runId: string;
    readonly jobId: string;
    readonly status: RunStatus;
    readonly timeline: readonly RunTimelineEntry[];
    readonly terminalCode?: string;
}
type CompletionEventType = 'job_completed' | 'job_failed' | 'job_canceled' | 'job_expired' | 'job_timed_out';
interface CompletionEvent {
    readonly eventType: CompletionEventType;
    readonly jobId: string;
    readonly runId: string;
    readonly status: TerminalRunStatus;
    readonly correlationId?: string;
    readonly workflowId?: string;
    readonly summary: RunResultSummary;
    readonly emittedAtMs: number;
}
type GatewayErrorCategory = 'validation_error' | 'missing_dataset' | 'unsupported_data_needs' | 'sandbox_module_error' | 'runner_failure' | 'internal_gateway_error';
interface GatewayError {
    readonly category: GatewayErrorCategory;
    readonly code: string;
    readonly message: string;
}
type ValidationStatus = 'accepted' | 'accepted_with_warnings' | 'rejected';
interface ValidationIssue {
    readonly code: string;
    readonly severity: 'error' | 'warning';
    readonly path?: string;
    readonly message: string;
}
interface ValidationReport {
    readonly status: ValidationStatus;
    readonly issues: readonly ValidationIssue[];
    readonly executed: false;
}
interface CapabilityDescriptor {
    readonly contractVersion: string;
    readonly artifactContractVersion: string;
    readonly supportedMetrics: readonly string[];
    readonly supportedModes: readonly RunMode[];
    readonly maxConcurrency: number;
}
interface DatasetDescriptor {
    readonly datasetRef: string;
    readonly symbols: readonly string[];
    readonly timeframe: string;
    readonly period: RunPeriod;
    readonly rowCount: number;
}
declare const CONTRACT_VERSION = "017.2";
declare const ARTIFACT_CONTRACT_VERSION = "022.1";
declare const BUNDLE_CONTRACT_VERSION = "019.1";
declare const HISTORICAL_DATA_CONTRACT_VERSION = "030.1";

declare class BacktesterError extends Error {
    readonly status: number;
    readonly code: string;
    readonly category?: string | undefined;
    readonly payload?: unknown | undefined;
    constructor(status: number, code: string, message: string, category?: string | undefined, payload?: unknown | undefined);
}
/** 400 — invalid request / module / run (validation_error). */
declare class BacktesterValidationError extends BacktesterError {
}
/** 409 — e.g. resume_token reused with a different request, or result requested before completion. */
declare class BacktesterConflictError extends BacktesterError {
}
/** 404 — run / artifact / dataset not found. */
declare class BacktesterNotFoundError extends BacktesterError {
}
/** 401 — missing or invalid bearer token. */
declare class BacktesterAuthError extends BacktesterError {
}

interface FetchLikeInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}
interface FetchLikeResponse {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;
interface BacktesterClientOptions {
    readonly baseUrl: string;
    readonly token: string;
    /** Defaults to the global `fetch`. */
    readonly fetchImpl?: FetchLike;
}
interface ReadArtifactOptions {
    offset?: number;
    limit?: number;
}
interface AwaitCompletionOptions {
    intervalMs?: number;
    timeoutMs?: number;
    /** Injectable sleep for tests. */
    sleep?: (ms: number) => Promise<void>;
}
declare class BacktesterClient {
    private readonly base;
    private readonly token;
    private readonly fetchImpl;
    constructor(opts: BacktesterClientOptions);
    private request;
    private raise;
    getCapabilities(): Promise<CapabilityDescriptor>;
    listDatasets(): Promise<DatasetDescriptor[]>;
    validateModule(req: unknown): Promise<ValidationReport>;
    submitRun(req: RunSubmitRequest): Promise<RunJobHandle>;
    getRunStatus(runId: string): Promise<RunStatusView>;
    /** Throws BacktesterConflictError (409) when the run has not produced a result yet. */
    getRunResult(runId: string): Promise<RunResultSummary>;
    getArtifactManifest(runId: string): Promise<ArtifactManifest>;
    readArtifact(runId: string, artifactId: string, opts?: ReadArtifactOptions): Promise<ArtifactPage>;
    cancelRun(runId: string): Promise<RunStatusView>;
    /** Poll status until terminal (or timeout). Returns the last status view either way. */
    awaitCompletion(runId: string, opts?: AwaitCompletionOptions): Promise<RunStatusView>;
}

export { ARTIFACT_CONTRACT_VERSION, type ArtifactAvailability, type ArtifactDescriptor, type ArtifactManifest, type ArtifactPage, type ArtifactReference, type AwaitCompletionOptions, BUNDLE_CONTRACT_VERSION, type BacktestRunRequest, BacktesterAuthError, BacktesterClient, type BacktesterClientOptions, BacktesterConflictError, BacktesterError, BacktesterNotFoundError, BacktesterValidationError, CONTRACT_VERSION, type CapabilityDescriptor, type CompletionEvent, type CompletionEventType, type ContentHash, type DatasetDescriptor, type FetchLike, type FetchLikeInit, type FetchLikeResponse, type GatewayError, type GatewayErrorCategory, HISTORICAL_DATA_CONTRACT_VERSION, type ModuleBundle, type ModuleKind, type ModuleManifest, type NonTerminalRunStatus, type ReadArtifactOptions, type Ref, type RunEvidence, type RunJobHandle, type RunMode, type RunPeriod, type RunResultSummary, type RunStatus, type RunStatusView, type RunSubmitRequest, type RunTimelineEntry, type TerminalRunStatus, type ValidationIssue, type ValidationReport, type ValidationStatus };
