// BacktesterClient — the typed service-to-service HTTP client for the trading-backtester API.
//
// This is the ONLY path through which a consumer (trading-lab via HttpBacktesterAdapter) submits and
// reads backtests: submit / status / result / artifacts / cancel. It is independent of any platform
// client. Uses global fetch by default; a `fetchImpl` can be injected for tests.

import type {
  ArtifactManifest,
  ArtifactPage,
  CapabilityDescriptor,
  DatasetDescriptor,
  RunJobHandle,
  RunResultSummary,
  RunStatusView,
  RunSubmitRequest,
  TerminalRunStatus,
  ValidationReport,
} from './wire';
import {
  BacktesterAuthError,
  BacktesterConflictError,
  BacktesterError,
  BacktesterNotFoundError,
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
}
export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface BacktesterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
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

export class BacktesterClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: BacktesterClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
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

    const res = await this.fetchImpl(`${this.base}${path}`, init);
    if (res.ok) return (await res.json()) as T;
    return this.raise(res, path);
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
      default:
        throw new BacktesterError(res.status, code, message, category, payload);
    }
  }

  getCapabilities(): Promise<CapabilityDescriptor> {
    return this.request('GET', '/v1/capabilities');
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const body = await this.request<{ datasets: DatasetDescriptor[] }>('GET', '/v1/datasets');
    return body.datasets;
  }

  validateModule(req: unknown): Promise<ValidationReport> {
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
