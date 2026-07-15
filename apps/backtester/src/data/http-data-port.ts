// platformDataClient — HTTP adapter (Slice 4). Implements the SAME seam as the in-process fixture
// reader (BacktesterDataPort / HistoricalDatasetReader), so the runner and worker are unchanged and
// the choice is purely config. The backtester gets historical data ONLY through this networked
// contract (no direct parquet/snapshot mount) and holds NO exchange credentials — at most a bearer
// token for the data API itself. Rows are fetched lazily one page at a time (cursor paging), so a
// full dataset never lands in memory and the consumer drives back-pressure.
//
// P2-12 resilience: every request has a per-request timeout (AbortController) that spans fetch AND body
// read/parse — a stalled body cannot wedge a worker; a bounded retry (transient network / body-parse /
// 408 / 429 / 5xx only; 4xx-except-408/429 fail fast) with a deadline-capped backoff; and the cursor
// loop detects a repeated cursor and enforces max pages/rows fail-closed BEFORE materialize() can grow.
// All failures map to RealDataUnavailableError (the existing data taxonomy → worker terminal
// `missing_dataset`), so a hung or looping upstream can never wedge a claiming worker.

import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  HistoricalRowsPage,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';
import { RealDataUnavailableError, type RealDataCause } from './rows-data-port';

type FetchImpl = typeof globalThis.fetch;

export interface HttpDataPortOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly pageLimit?: number;
  /** Injectable fetch (for tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout (ms) — spans fetch + body read/parse. Default 30000. */
  readonly timeoutMs?: number;
  /** Total attempts per request including the first (1 = no retry). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff base delay (ms), full jitter, doubled per attempt. Default 500. */
  readonly retryBaseMs?: number;
  /** Backoff ceiling (ms). Default 10000. */
  readonly retryMaxMs?: number;
  /** Fail-closed cap on pages fetched by a single queryRange. Default 10000. */
  readonly maxPages?: number;
  /** Fail-closed cap on rows accumulated by a single queryRange (guards materialize growth). Default 5_000_000. */
  readonly maxRows?: number;
  /** Optional operation deadline (ms) bounding a whole queryRange across pages+retries+sleeps. 0 = off. Default 0. */
  readonly operationDeadlineMs?: number;
  /** @internal test seam — replaces real backoff sleeping. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

interface Resilience {
  readonly fetchImpl: FetchImpl;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly maxPages: number;
  readonly maxRows: number;
  readonly operationDeadlineMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 60_000;

/** Numeric-seconds-only Retry-After (clamped): HTTP-date or garbage → undefined. */
function retryAfterMs(res: Response): number | undefined {
  const ra = res.headers?.get?.('retry-after');
  if (ra !== undefined && ra !== null && /^\d+$/.test(ra.trim())) {
    return Math.min(Number(ra.trim()) * 1000, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function backoffMs(attempt: number, r: Resilience): number {
  const exp = Math.min(r.retryMaxMs, r.retryBaseMs * 2 ** (attempt - 1));
  return Math.max(1, Math.floor(Math.random() * exp)); // full jitter
}

/** Sleep `ms`, but never past the operation deadline — so a long Retry-After can't overshoot it. */
async function sleepBounded(ms: number, deadlineAt: number | undefined, r: Resilience): Promise<void> {
  const capped = deadlineAt !== undefined ? Math.min(ms, Math.max(0, deadlineAt - Date.now())) : ms;
  if (capped > 0) await r.sleep(capped);
}

/**
 * Fetch `url` with a per-request timeout that spans BOTH the fetch and the body read/parse, plus a
 * bounded retry. All data-API requests are GET (idempotent), so a network / timeout / body-parse error
 * is retryable. `readBody` false skips the body (reachability probe, e.g. openDataset). Every terminal
 * failure is a RealDataUnavailableError. `deadlineAt` (absolute epoch ms) caps the total time.
 */
async function resilientRequest<T>(
  url: string,
  headers: Record<string, string>,
  r: Resilience,
  datasetRef: string,
  deadlineAt: number | undefined,
  readBody: boolean,
): Promise<T | undefined> {
  let lastCause: RealDataCause = 'rows_resource_unavailable';
  for (let attempt = 1; attempt <= r.maxAttempts; attempt += 1) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new RealDataUnavailableError('timeout', datasetRef);
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const budget =
      deadlineAt !== undefined ? Math.min(r.timeoutMs, Math.max(1, deadlineAt - Date.now())) : r.timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, budget);

    let outcome: { ok: true; body: T | undefined } | { ok: false; status: number; retryAfter?: number };
    try {
      const res = await r.fetchImpl(url, { headers, signal: ctrl.signal });
      // The body read stays INSIDE the timer window: a stalled body aborts on the same signal.
      if (res.ok) outcome = { ok: true, body: readBody ? ((await res.json()) as T) : undefined };
      else outcome = { ok: false, status: res.status, retryAfter: res.status === 429 ? retryAfterMs(res) : undefined };
    } catch {
      clearTimeout(timer);
      // Timeout (headers OR body) → 'timeout'; any other throw (network / body-parse) → transient unavailable.
      lastCause = timedOut ? 'timeout' : 'rows_resource_unavailable';
      if (attempt === r.maxAttempts) throw new RealDataUnavailableError(lastCause, datasetRef);
      await sleepBounded(backoffMs(attempt, r), deadlineAt, r);
      continue;
    }
    clearTimeout(timer);

    if (outcome.ok) return outcome.body;

    const status = outcome.status;
    // Permanent 4xx (except 408/429) → fail fast, no retry.
    if (status === 401 || status === 403) throw new RealDataUnavailableError('unauthorized', datasetRef);
    if (status === 404) throw new RealDataUnavailableError('dataset_not_found', datasetRef);
    const transient = status === 408 || status === 429 || (status >= 500 && status <= 599);
    if (!transient) throw new RealDataUnavailableError('discover_failed', datasetRef);

    lastCause = status === 429 ? 'rate_limited' : 'rows_resource_unavailable';
    if (attempt === r.maxAttempts) throw new RealDataUnavailableError(lastCause, datasetRef);
    await sleepBounded(outcome.retryAfter ?? backoffMs(attempt, r), deadlineAt, r);
  }
  throw new RealDataUnavailableError(lastCause, datasetRef);
}

class HttpDatasetReader implements HistoricalDatasetReader {
  constructor(
    private readonly base: string,
    private readonly datasetRef: string,
    private readonly headers: Record<string, string>,
    private readonly pageLimit: number,
    private readonly r: Resilience,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    const deadlineAt = this.r.operationDeadlineMs > 0 ? Date.now() + this.r.operationDeadlineMs : undefined;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let rows = 0;
    for (;;) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new RealDataUnavailableError('timeout', this.datasetRef);
      }
      const params = new URLSearchParams({
        datasetRef: this.datasetRef,
        tsFrom: String(q.tsFrom),
        tsTo: String(q.tsTo),
        limit: String(this.pageLimit),
      });
      if (q.symbols && q.symbols.length > 0) params.set('symbols', q.symbols.join(','));
      if (cursor) params.set('cursor', cursor);

      const page = (await resilientRequest<HistoricalRowsPage>(
        `${this.base}/data/v1/rows?${params.toString()}`,
        this.headers,
        this.r,
        this.datasetRef,
        deadlineAt,
        true,
      ))!;

      // Fail-closed BEFORE yielding (materialize accumulates every yielded row): bound pages and rows.
      pages += 1;
      if (pages > this.r.maxPages) throw new RealDataUnavailableError('pagination_overflow', this.datasetRef);
      rows += page.rows.length;
      if (rows > this.r.maxRows) throw new RealDataUnavailableError('pagination_overflow', this.datasetRef);

      if (page.rows.length > 0) yield page.rows as ReaderRow[];
      if (!page.nextCursor) return;
      // A cursor equal to the current one (or already seen) is a non-advancing upstream → stop, don't loop.
      if (page.nextCursor === cursor || seen.has(page.nextCursor)) {
        throw new RealDataUnavailableError('pagination_cycle', this.datasetRef);
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async *queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]> {
    yield* this.queryRange({ tsFrom: q.tsFrom, tsTo: q.tsTo, symbols: [q.symbol] });
  }
}

export class HttpDataPort implements BacktesterDataPort {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly pageLimit: number;
  private readonly r: Resilience;

  constructor(opts: HttpDataPortOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
    this.pageLimit = opts.pageLimit ?? 1000;
    this.r = {
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxAttempts: opts.maxAttempts ?? 3,
      retryBaseMs: opts.retryBaseMs ?? 500,
      retryMaxMs: opts.retryMaxMs ?? 10_000,
      maxPages: opts.maxPages ?? 10_000,
      maxRows: opts.maxRows ?? 5_000_000,
      operationDeadlineMs: opts.operationDeadlineMs ?? 0,
      sleep: opts.sleepImpl ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))),
    };
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const body = (await resilientRequest<{ datasets: DatasetDescriptor[] }>(
      `${this.base}/data/v1/datasets`,
      this.headers,
      this.r,
      '(datasets)',
      undefined,
      true,
    ))!;
    return body.datasets;
  }

  async openDataset(datasetRef: string): Promise<HistoricalDatasetReader | undefined> {
    try {
      // Reachability probe (no body): resolves on 2xx, undefined on 404, else a typed failure.
      await resilientRequest(
        `${this.base}/data/v1/datasets/${encodeURIComponent(datasetRef)}`,
        this.headers,
        this.r,
        datasetRef,
        undefined,
        false,
      );
    } catch (err) {
      // A missing dataset is a normal answer (undefined), not an error — matches the prior 404 handling.
      if (err instanceof RealDataUnavailableError && err.reason === 'dataset_not_found') return undefined;
      throw err;
    }
    return new HttpDatasetReader(this.base, datasetRef, this.headers, this.pageLimit, this.r);
  }
}
