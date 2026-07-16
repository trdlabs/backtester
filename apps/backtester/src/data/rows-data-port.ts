// RowsDataPort — BacktesterDataPort backed by the platform's unified `/historical/rows`
// surface (historical.2). Unlike MockPlatformDataPort it reads a SINGLE endpoint that already
// emits full CanonicalRowV2 rows (OHLCV + oi + funding + liquidations + taker + turnover), so no
// per-kind merge is needed: each row maps 1:1 to ReaderRow (dropping only `schema_version`).
// historical.2-only: if the platform reports an older contract or no available `rows` resource,
// openDataset returns undefined (no fallback to the legacy three-endpoint merge).
//
// This is a THIN adapter over the SDK's `HistoricalClient` (@trdlabs/sdk/historical):
// fetch / pagination / cursor / bearer-token are all owned by the SDK client; this module only
// maps the wire DTOs (CanonicalRowV2, coverage/discover responses) into the backtester's
// ReaderRow / DatasetDescriptor shapes and enforces the historical.2 guard.

import {
  HistoricalClient,
  type CanonicalRowV2,
} from '@trdlabs/sdk/historical';
import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

// ── Public API ────────────────────────────────────────────────────────────────

export type RealDataCause =
  | 'unauthorized'
  | 'connection_refused'
  | 'contract_version_mismatch'
  | 'rows_resource_unavailable'
  | 'dataset_not_found'
  | 'discover_failed'
  // P2-12: HttpDataPort resilience causes. The worker maps ANY RealDataUnavailableError to the single
  // terminal code `missing_dataset` (worker.ts), so these enrich the errorDetail without a new terminal.
  | 'timeout'
  | 'rate_limited'
  | 'pagination_cycle'
  | 'pagination_overflow';

/** Thrown by RowsDataPort.openDataset on any platform-side failure. `message` is the fixed
 *  errorDetail string contract: `cause=<reason>; datasetRef=<datasetRef>`. */
export class RealDataUnavailableError extends Error {
  constructor(readonly reason: RealDataCause, readonly datasetRef: string) {
    super(`cause=${reason}; datasetRef=${datasetRef}`);
    this.name = 'RealDataUnavailableError';
  }
}

/**
 * Normalize a discover() failure into a finite cause. Raw SDK/Node text never surfaces past
 * this function — HistoricalClient.discover() throws a plain `Error` with message
 * `platform /historical/discover: HTTP <status>` on a non-2xx response, or whatever the
 * underlying fetch implementation throws on a network failure (Node's fetch throws
 * `TypeError: fetch failed` with `cause.code === 'ECONNREFUSED'` for a refused connection).
 * `discover_failed` is the safe fallback for anything unclassifiable.
 */
function classifyDiscoverError(err: unknown): RealDataCause {
  const anyErr = err as { message?: string; code?: string; cause?: { code?: string } } | undefined;
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : '';
  const httpStatus = /HTTP (\d{3})\b/.exec(msg)?.[1];
  if (httpStatus === '401' || httpStatus === '403') return 'unauthorized';
  const netCode = anyErr?.code ?? anyErr?.cause?.code;
  if (netCode === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'connection_refused';
  return 'discover_failed';
}

type FetchLike = typeof globalThis.fetch;

export interface RowsDataPortOptions {
  readonly baseUrl: string;
  /** Injectable fetch implementation (for tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchLike;
  /** Rows per page when fetching /historical/rows. Default 1000. */
  readonly pageLimit?: number;
  /** Per-request timeout (ms), including response body consumption. */
  readonly timeoutMs?: number;
  /** Total request attempts, including the first. */
  readonly maxAttempts?: number;
  /** Retry backoff base delay (ms). */
  readonly retryBaseMs?: number;
  /** Retry backoff ceiling (ms). */
  readonly retryMaxMs?: number;
  /** Fail-closed cap on pages fetched by a single rows query. */
  readonly maxPages?: number;
  /** Fail-closed cap on rows accumulated by a single rows query. */
  readonly maxRows?: number;
  /** Optional deadline (ms) for a complete rows query. */
  readonly operationDeadlineMs?: number;
  /** Bearer token for platform auth. */
  readonly token?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msToISO(ms: number): string {
  return new Date(ms).toISOString();
}

/** Map a CanonicalRowV2 wire row to a ReaderRow by dropping schema_version (all else 1:1). */
function toReaderRow(row: CanonicalRowV2): ReaderRow {
  const { schema_version: _schemaVersion, ...rest } = row;
  return rest;
}

// ── RowsReader ──────────────────────────────────────────────────────────────────

export class RowsReader implements HistoricalDatasetReader {
  constructor(
    private readonly client: HistoricalClient,
    private readonly symbol: string,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    // Honour the requested symbol set — multi-symbol universe runs pass all request.symbols
    // through buildOverlayDataset; fall back to the datasetRef-bound symbol when omitted.
    // client.queryRows is already multi-symbol, so every symbol streams from one call.
    const symbols = q.symbols !== undefined && q.symbols.length > 0 ? [...q.symbols] : [this.symbol];
    for await (const page of this.client.queryRows({
      symbols,
      fromMs: q.tsFrom,
      toMs: q.tsTo,
    })) {
      yield page.map(toReaderRow);
    }
  }

  async *queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]> {
    yield* this.queryRange({ tsFrom: q.tsFrom, tsTo: q.tsTo, symbols: [q.symbol] });
  }
}

// ── RowsDataPort ──────────────────────────────────────────────────────────────

export class RowsDataPort implements BacktesterDataPort {
  private readonly client: HistoricalClient;

  constructor(opts: RowsDataPortOptions) {
    this.client = new HistoricalClient({
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      pageLimit: opts.pageLimit ?? 1000,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      maxAttempts: opts.maxAttempts,
      retryBaseMs: opts.retryBaseMs,
      retryMaxMs: opts.retryMaxMs,
      maxPages: opts.maxPages,
      maxRows: opts.maxRows,
      operationDeadlineMs: opts.operationDeadlineMs,
    });
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const snapshot = await this.client.coverage();
    if (snapshot.availability === 'unavailable') return [];
    return snapshot.entries
      .filter((e) => e.availability === 'available' && e.barCount > 0)
      .map((e) => ({
        datasetRef: `${e.symbol}:${e.timeframe}`,
        symbols:    [e.symbol] as readonly string[],
        timeframe:  e.timeframe,
        period:     { from: msToISO(e.fromMs), to: msToISO(e.toMs) },
        rowCount:   e.barCount,
      }));
  }

  async openDataset(ref: string): Promise<HistoricalDatasetReader | undefined> {
    const colonIdx = ref.indexOf(':');
    if (colonIdx <= 0) return undefined;
    const symbol = ref.slice(0, colonIdx);
    const timeframe = ref.slice(colonIdx + 1);
    if (!symbol || !timeframe) return undefined;

    let descriptor;
    try {
      descriptor = await this.client.discover();
    } catch (err) {
      throw new RealDataUnavailableError(classifyDiscoverError(err), ref);
    }

    // historical.2-only: refuse to read anything else (no legacy merge fallback).
    if (descriptor.historicalContractVersion !== 'historical.2') {
      throw new RealDataUnavailableError('contract_version_mismatch', ref);
    }
    const rowsResource = descriptor.resources.find((r) => r.name === 'rows');
    if (!rowsResource || rowsResource.availability !== 'available') {
      throw new RealDataUnavailableError('rows_resource_unavailable', ref);
    }

    if (!descriptor.symbols.includes(symbol) || !descriptor.timeframes.includes(timeframe)) {
      throw new RealDataUnavailableError('dataset_not_found', ref);
    }

    return new RowsReader(this.client, symbol);
  }
}
