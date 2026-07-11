// Historical market-data contract — the shape the backtester's `platformDataClient` speaks.
//
// SINGLE SOURCE OF TRUTH = the platform SDK's `CanonicalRowV2` (`@trdlabs/sdk/historical`).
// `CanonicalRow` is that row minus `schema_version` (the engine stamps the version downstream);
// `ReaderRow` is its alias. We import rather than re-declare the columns, so the backtester can
// never drift from the platform contract. The reader is credential-free and streaming. For Slice 1
// the only implementation is an in-process fixture reader; a networked "Research Historical Data API"
// adapter implements the same interface later (real vs mock interchangeable at the interface).

import type { CanonicalRowV2 } from '@trdlabs/sdk/historical';

/** One minute-aligned canonical market row (cross-source aggregate; no per-venue columns). */
export type CanonicalRow = Omit<CanonicalRowV2, 'schema_version'>;

export type ReaderRow = CanonicalRow;

/** Half-open window `[tsFrom, tsTo)` in epoch ms, optional symbol filter. */
export interface RangeQuery {
  readonly tsFrom: number;
  readonly tsTo: number;
  readonly symbols?: readonly string[];
}

export interface OneSymbolQuery {
  readonly symbol: string;
  readonly tsFrom: number;
  readonly tsTo: number;
}

/** The platform-owned fetch contract. Batched (memory-bounded); no credentials. */
export interface HistoricalDatasetReader {
  queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]>;
  queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]>;
  close?(): Promise<void>;
}

/**
 * One page of the networked Research Historical Data API (Slice 4). `nextCursor` is an opaque token;
 * absent on the last page. The wire rendering of `HistoricalDatasetReader.queryRange` — streaming and
 * paged so neither side loads a whole dataset into memory. trading-platform and trading-mock-platform
 * implement this identically; the backtester consumes it credential-free over HTTP.
 */
export interface HistoricalRowsPage {
  readonly rows: readonly ReaderRow[];
  readonly nextCursor?: string;
}
