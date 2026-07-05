// RowsDataPort — BacktesterDataPort backed by the platform's unified `/historical/rows`
// surface (historical.2). Unlike MockPlatformDataPort it reads a SINGLE endpoint that already
// emits full CanonicalRowV2 rows (OHLCV + oi + funding + liquidations + taker + turnover), so no
// per-kind merge is needed: each row maps 1:1 to ReaderRow (dropping only `schema_version`).
// historical.2-only: if the platform reports an older contract or no available `rows` resource,
// openDataset returns undefined (no fallback to the legacy three-endpoint merge).
//
// This is a THIN adapter over the SDK's `HistoricalClient` (@trading-platform/sdk/historical):
// fetch / pagination / cursor / bearer-token are all owned by the SDK client; this module only
// maps the wire DTOs (CanonicalRowV2, coverage/discover responses) into the backtester's
// ReaderRow / DatasetDescriptor shapes and enforces the historical.2 guard.

import {
  HistoricalClient,
  type CanonicalRowV2,
} from '@trading-platform/sdk/historical';
import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

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
    private readonly client: HistoricalClient,
    private readonly symbol: string,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    for await (const page of this.client.queryRows({
      symbols: [this.symbol],
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
    } catch {
      return undefined;
    }

    // historical.2-only: refuse to read anything else (no legacy merge fallback).
    if (descriptor.historicalContractVersion !== 'historical.2') return undefined;
    const rowsResource = descriptor.resources.find((r) => r.name === 'rows');
    if (!rowsResource || rowsResource.availability !== 'available') return undefined;

    if (!descriptor.symbols.includes(symbol)) return undefined;
    if (!descriptor.timeframes.includes(timeframe)) return undefined;

    return new RowsReader(this.client, symbol);
  }
}
