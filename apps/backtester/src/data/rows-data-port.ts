// RowsDataPort — BacktesterDataPort backed by the platform's unified `/historical/rows`
// surface (historical.2). Unlike MockPlatformDataPort it reads a SINGLE endpoint that already
// emits full CanonicalRowV2 rows (OHLCV + oi + funding + liquidations + taker + turnover), so no
// per-kind merge is needed: each row maps 1:1 to ReaderRow (dropping only `schema_version`).
// historical.2-only: if the platform reports an older contract or no available `rows` resource,
// openDataset returns undefined (no fallback to the legacy three-endpoint merge).

import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

// ── Wire types: mirrors the platform historical.2 contract (no cross-repo import) ──

/** CanonicalRowV2 = ReaderRow + schema_version. The 18 ReaderRow fields are copied verbatim. */
interface CanonicalRowV2 extends ReaderRow {
  readonly schema_version: number;
}

interface PageEnvelope<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

interface CoverageEntry {
  readonly symbol: string;
  readonly timeframe: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly barCount: number;
  readonly availability: string;
}

interface CoverageSnapshot {
  readonly entries: readonly CoverageEntry[];
  readonly availability: string;
}

interface ResourceDescriptor {
  readonly name: string;
  readonly availability: string;
}

interface DiscoverResponse {
  readonly historicalContractVersion: string;
  readonly symbols: readonly string[];
  readonly timeframes: readonly string[];
  readonly resources: readonly ResourceDescriptor[];
}

// ── Public API ────────────────────────────────────────────────────────────────

type FetchLike = typeof globalThis.fetch;

export interface RowsDataPortOptions {
  readonly baseUrl: string;
  /** Injectable fetch implementation (for tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchLike;
  /** Rows per page when fetching /historical/rows. Default 1000. */
  readonly pageLimit?: number;
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
    private readonly base: string,
    private readonly symbol: string,
    private readonly pageLimit: number,
    private readonly fetchImpl: FetchLike,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    let cursor: string | null = null;
    for (;;) {
      const params = new URLSearchParams({
        symbols: this.symbol,
        fromMs:  String(q.tsFrom),
        toMs:    String(q.tsTo),
        limit:   String(this.pageLimit),
      });
      if (cursor) params.set('cursor', cursor);

      const res = await this.fetchImpl(`${this.base}/historical/rows?${params.toString()}`);
      if (!res.ok) throw new Error(`platform /historical/rows: HTTP ${res.status}`);
      const page = (await res.json()) as PageEnvelope<CanonicalRowV2>;
      if (page.items.length > 0) yield page.items.map(toReaderRow);
      cursor = page.nextCursor;
      if (!cursor) return;
    }
  }

  async *queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]> {
    yield* this.queryRange({ tsFrom: q.tsFrom, tsTo: q.tsTo, symbols: [q.symbol] });
  }
}

// ── RowsDataPort ──────────────────────────────────────────────────────────────

export class RowsDataPort implements BacktesterDataPort {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly pageLimit: number;

  constructor(opts: RowsDataPortOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    const rawFetch = opts.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = opts.token
      ? (url, init) => rawFetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${opts.token}` } })
      : rawFetch;
    this.pageLimit = opts.pageLimit ?? 1000;
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const res = await this.fetchImpl(`${this.base}/historical/coverage`);
    if (!res.ok) throw new Error(`platform /historical/coverage: HTTP ${res.status}`);
    const snapshot = (await res.json()) as CoverageSnapshot;
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

    const res = await this.fetchImpl(`${this.base}/historical/discover`);
    if (!res.ok) return undefined;
    const descriptor = (await res.json()) as DiscoverResponse;

    // historical.2-only: refuse to read anything else (no legacy merge fallback).
    if (descriptor.historicalContractVersion !== 'historical.2') return undefined;
    const rowsResource = descriptor.resources.find((r) => r.name === 'rows');
    if (!rowsResource || rowsResource.availability !== 'available') return undefined;

    if (!descriptor.symbols.includes(symbol)) return undefined;
    if (!descriptor.timeframes.includes(timeframe)) return undefined;

    return new RowsReader(this.base, symbol, this.pageLimit, this.fetchImpl);
  }
}
