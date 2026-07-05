// BacktesterClient — the typed service-to-service HTTP client for the trading-backtester API.
//
// This is the ONLY path through which a consumer (trading-lab via HttpBacktesterAdapter) submits and
// reads backtests: submit / status / result / artifacts / cancel. It is independent of any platform
// client. Uses global fetch by default; a `fetchImpl` can be injected for tests.

import type {
  ArtifactManifest,
  ArtifactPage,
} from '../artifacts/index';
import type {
  CapabilityDescriptor,
  DatasetDescriptor,
  ModuleValidateRequest,
  RegistryDescriptor,
  RunJobHandle,
  RunResultSummary,
  RunStatusView,
  RunSubmitRequest,
  TerminalRunStatus,
  ValidationReport,
} from '../contracts/index';
import {
  BacktesterAuthError,
  BacktesterConflictError,
  BacktesterError,
  BacktesterNotFoundError,
  BacktesterRateLimitError,
  BacktesterValidationError,
} from './errors';

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Optional (additive): lets the client read Retry-After. Fakes without it keep working. */
  headers?: { get(name: string): string | null };
}
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface RetryOptions {
  /** Total attempts including the first (1 = no retries). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff base delay (ms), full jitter, doubled per attempt. Default 500. */
  readonly baseDelayMs?: number;
  /** Backoff ceiling (ms). Default 10000. */
  readonly maxDelayMs?: number;
  /** @internal test seam — replaces real sleeping. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface BacktesterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Safe-retry policy (429 always; network/5xx only when idempotent). Default ON (3 attempts). */
  readonly retry?: RetryOptions;
}

export interface ReadArtifactOptions {
  offset?: number;
  limit?: number;
}

export interface AwaitCompletionOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL: ReadonlySet<string> = new Set<TerminalRunStatus>([
  'completed',
  'failed',
  'canceled',
  'expired',
  'timed_out',
]);

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ceiling for an honored Retry-After wait — see the clamp comment in the retry loop. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Numeric-seconds-only Retry-After (scope anchor): HTTP-date or garbage → undefined. */
function numericRetryAfterS(res: FetchLikeResponse): number | undefined {
  const ra = res.headers?.get('retry-after');
  return ra !== undefined && ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : undefined;
}

export class BacktesterClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryOptions;

  constructor(opts: BacktesterClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.retry = opts.retry ?? {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: FetchLikeInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    // Idempotency: GETs always; mutations only when the body carries a resumeToken (replay contract).
    const idempotent =
      method === 'GET' ||
      (typeof body === 'object' && body !== null && typeof (body as { resumeToken?: unknown }).resumeToken === 'string');

    const maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts ?? 3) || 1);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: FetchLikeResponse;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, init);
      } catch (err) {
        lastErr = err;
        if (!idempotent || attempt === maxAttempts) throw err;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || (idempotent && (res.status === 502 || res.status === 503 || res.status === 504));
      if (!retryable || attempt === maxAttempts) return this.raise(res, path);
      const raSeconds = numericRetryAfterS(res);
      // Retry-After is honored but CLAMPED to MAX_RETRY_AFTER_MS: a server/proxy advertising an
      // hour must not block the client's retry loop for an hour — worst case we retry early and
      // collect another 429.
      await this.sleep(raSeconds !== undefined ? Math.min(raSeconds * 1000, MAX_RETRY_AFTER_MS) : this.backoffMs(attempt));
    }
    throw lastErr instanceof Error ? lastErr : new Error('retry loop exhausted');
  }

  private backoffMs(attempt: number): number {
    const base = Math.max(1, this.retry.baseDelayMs ?? 500);
    const cap = Math.max(1, this.retry.maxDelayMs ?? 10_000);
    const exp = Math.min(cap, base * 2 ** (attempt - 1));
    return Math.max(1, Math.floor(Math.random() * exp)); // full jitter
  }

  private sleep(ms: number): Promise<void> {
    return (this.retry.sleepImpl ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }

  private async raise(res: FetchLikeResponse, path: string): Promise<never> {
    let payload: { code?: string; message?: string; category?: string } | undefined;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    const code = payload?.code ?? 'error';
    const message = payload?.message ?? `backtester responded ${res.status} for ${path}`;
    const category = payload?.category;
    switch (res.status) {
      case 400:
        throw new BacktesterValidationError(res.status, code, message, category, payload);
      case 401:
        throw new BacktesterAuthError(res.status, code, message, category, payload);
      case 404:
        throw new BacktesterNotFoundError(res.status, code, message, category, payload);
      case 409:
        throw new BacktesterConflictError(res.status, code, message, category, payload);
      case 429:
        throw new BacktesterRateLimitError(res.status, code, message, category, payload, numericRetryAfterS(res));
      default:
        throw new BacktesterError(res.status, code, message, category, payload);
    }
  }

  discoverRegistry(): Promise<RegistryDescriptor> {
    return this.request('GET', '/v1/registry');
  }

  getCapabilities(): Promise<CapabilityDescriptor> {
    return this.request('GET', '/v1/capabilities');
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const body = await this.request<{ datasets: DatasetDescriptor[] }>('GET', '/v1/datasets');
    return body.datasets;
  }

  validateModule(req: ModuleValidateRequest): Promise<ValidationReport> {
    return this.request('POST', '/v1/modules/validate', req);
  }

  submitRun(req: RunSubmitRequest): Promise<RunJobHandle> {
    return this.request('POST', '/v1/runs', req);
  }

  getRunStatus(runId: string): Promise<RunStatusView> {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/status`);
  }

  /** Throws BacktesterConflictError (409) when the run has not produced a result yet. */
  getRunResult(runId: string): Promise<RunResultSummary> {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/result`);
  }

  getArtifactManifest(runId: string): Promise<ArtifactManifest> {
    return this.request('GET', `/v1/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  readArtifact(runId: string, artifactId: string, opts: ReadArtifactOptions = {}): Promise<ArtifactPage> {
    const q = new URLSearchParams();
    if (opts.offset !== undefined) q.set('offset', String(opts.offset));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}${qs ? `?${qs}` : ''}`,
    );
  }

  cancelRun(runId: string): Promise<RunStatusView> {
    return this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/cancel`);
  }

  /** Poll status until terminal (or timeout). Returns the last status view either way. */
  async awaitCompletion(runId: string, opts: AwaitCompletionOptions = {}): Promise<RunStatusView> {
    const intervalMs = opts.intervalMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const sleep = opts.sleep ?? defaultSleep;
    const start = Date.now();
    for (;;) {
      const status = await this.getRunStatus(runId);
      if (TERMINAL.has(status.status)) return status;
      if (Date.now() - start > timeoutMs) return status;
      await sleep(intervalMs);
    }
  }
}
