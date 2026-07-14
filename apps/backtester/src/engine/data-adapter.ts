// Slice 6a — data adapter: feeds the backtester's data port into the lifted engine tape builder.
//
// `buildOverlayDataset(port, sel)` opens a `HistoricalDatasetReader` for `sel.datasetRef`, streams the
// half-open window `[from, to)` for `sel.symbols`, maps each data-layer `CanonicalRow` (root contract,
// no `schema_version`) into an engine `CanonicalRowV2` (research contract), and hands the rows to
// `marketTapeFromCanonicalRows` to materialize a `MarketTapeDataset`.
//
// `ReaderRow` now carries the full `CanonicalRowV2` field set (liquidations included), so the mapping
// adds only `schema_version: 2` and copies every column 1:1 — liquidations, taker flow, and turnover
// are all carried through verbatim. Sources without liquidation data set them to null/false.

import type {
  MarketTapeDataset,
  CanonicalRowV2,
  TapeBuildResult,
} from '@trading/research-contracts/research';
import type { CanonicalRow as ReaderRow } from '@trading/research-contracts';
import { marketTapeFromCanonicalRows } from './market-tape.js';
import type { BacktesterDataPort } from '../data/reader.js';
import { RunnerError } from '../runner/errors.js';

/** Selector identifying which dataset/window/symbols to materialize into an engine tape. */
export interface OverlayDatasetSelector {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  /** ISO-8601 half-open window `[from, to)`; parsed via `Date.parse` to epoch ms. */
  readonly period: { readonly from: string; readonly to: string };
}

/** Map one data-layer `CanonicalRow` → engine `CanonicalRowV2` (add schema_version; carry every field). */
export function toCanonicalRowV2(r: ReaderRow): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts: r.minute_ts,
    symbol: r.symbol,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    turnover: r.turnover,
    oi_total_usd: r.oi_total_usd,
    has_oi: r.has_oi,
    funding_rate: r.funding_rate,
    has_funding: r.has_funding,
    liq_long_usd: r.liq_long_usd,
    liq_short_usd: r.liq_short_usd,
    has_liquidations: r.has_liquidations,
    taker_buy_volume_usd: r.taker_buy_volume_usd,
    taker_sell_volume_usd: r.taker_sell_volume_usd,
    has_taker_flow: r.has_taker_flow,
  };
}

/**
 * Open `sel.datasetRef` on `port`, stream its `[from, to)` window for `sel.symbols`, and materialize an
 * engine `MarketTapeDataset` via `marketTapeFromCanonicalRows`. Throws on unknown dataset or a failed
 * tape build (`non_market_source`).
 */
export async function buildOverlayDataset(
  port: BacktesterDataPort,
  sel: OverlayDatasetSelector,
): Promise<MarketTapeDataset> {
  const reader = await port.openDataset(sel.datasetRef);
  if (reader === undefined) {
    throw new Error(`buildOverlayDataset: unknown dataset '${sel.datasetRef}'`);
  }

  // P2-19: bind the tape's timeframe to the SERVER-declared DatasetDescriptor, not the client's request
  // label. A client must not be able to relabel a real 1m dataset as '60m' (60×-charging funding) or
  // pass an unparseable/degenerate value. Require request == descriptor equality and materialize from the
  // descriptor's timeframe (the trusted funding cadence read downstream by the engine).
  const descriptor = (await port.listDatasets()).find((d) => d.datasetRef === sel.datasetRef);
  if (descriptor === undefined) {
    throw new RunnerError(
      'validation_error',
      `buildOverlayDataset: no dataset descriptor for '${sel.datasetRef}' — cannot verify timeframe`,
    );
  }
  if (sel.timeframe !== descriptor.timeframe) {
    throw new RunnerError(
      'validation_error',
      `buildOverlayDataset: request timeframe '${sel.timeframe}' != dataset descriptor timeframe '${descriptor.timeframe}' for '${sel.datasetRef}'`,
    );
  }

  const tsFrom = Date.parse(sel.period.from);
  const tsTo = Date.parse(sel.period.to);
  if (Number.isNaN(tsFrom) || Number.isNaN(tsTo)) {
    throw new RunnerError(
      'validation_error',
      `buildOverlayDataset: unparseable period [${sel.period.from}, ${sel.period.to})`,
    );
  }

  const mappedRows: CanonicalRowV2[] = [];
  for await (const batch of reader.queryRange({ tsFrom, tsTo, symbols: sel.symbols })) {
    for (const row of batch) mappedRows.push(toCanonicalRowV2(row));
  }

  const result: TapeBuildResult = marketTapeFromCanonicalRows(
    sel.datasetRef,
    descriptor.timeframe, // server-derived, validated == sel.timeframe above
    mappedRows,
  );
  if (!result.ok) {
    throw new Error(
      `buildOverlayDataset: tape build failed (${result.reason}): ${result.detail}`,
    );
  }
  return result.tape;
}
