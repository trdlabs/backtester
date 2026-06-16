// Historical market-data contract — the shape the backtester's `platformDataClient` speaks.
//
// Mirrors trading-platform `src/contracts/historical/{canonical-row,historical-dataset-reader}.ts`.
// A `ReaderRow` carries every data kind as columns with `has_*` presence flags (present-zero is
// distinguished from missing). The reader is credential-free and streaming. For Slice 1 the only
// implementation is an in-process fixture reader; a networked "Research Historical Data API" adapter
// implements the same interface later (real vs mock interchangeable at the interface).

/** One minute-aligned canonical market row (cross-source aggregate; no per-venue columns). */
export interface CanonicalRow {
  readonly symbol: string;
  /** Minute-aligned epoch ms (UTC): `minute_ts % 60_000 === 0`. */
  readonly minute_ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
  readonly oi_total_usd: number | null;
  readonly has_oi: boolean;
  readonly funding_rate: number | null;
  readonly has_funding: boolean;
  readonly taker_buy_volume_usd: number | null;
  readonly taker_sell_volume_usd: number | null;
  readonly has_taker_flow: boolean;
}

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
