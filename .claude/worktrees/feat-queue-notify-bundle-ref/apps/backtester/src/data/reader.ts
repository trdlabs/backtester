// platformDataClient (Slice 1, in-process). `BacktesterDataPort` is the seam; the only implementation
// here is `FixtureDataPort` over local JSON fixtures. A networked Research Historical Data API adapter
// implements the same `HistoricalDatasetReader`/`BacktesterDataPort` later — real vs mock are
// interchangeable at the interface, never by mounting files directly.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import { contentRef } from '../determinism/hash';

const BATCH = 256;

/** The backtester's data port: list datasets + open a reader bound to one dataset. */
export interface BacktesterDataPort {
  listDatasets(): Promise<DatasetDescriptor[]>;
  /** Returns a reader bound to `datasetRef`, or undefined when the dataset is unknown. */
  openDataset(datasetRef: string): Promise<HistoricalDatasetReader | undefined>;
}

interface FixtureFile {
  readonly datasetRef: string;
  readonly timeframe: string;
  readonly rows: ReaderRow[];
}

function sortRows(rows: readonly ReaderRow[]): ReaderRow[] {
  return [...rows].sort((a, b) =>
    a.symbol === b.symbol ? a.minute_ts - b.minute_ts : a.symbol < b.symbol ? -1 : 1,
  );
}

/** A reader bound to one already-loaded fixture. */
class FixtureReader implements HistoricalDatasetReader {
  constructor(private readonly rows: ReaderRow[]) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    const symbols = q.symbols ? new Set(q.symbols) : undefined;
    const matched = this.rows.filter(
      (r) =>
        r.minute_ts >= q.tsFrom &&
        r.minute_ts < q.tsTo &&
        (symbols === undefined || symbols.has(r.symbol)),
    );
    for (let i = 0; i < matched.length; i += BATCH) {
      yield matched.slice(i, i + BATCH);
    }
  }

  async *queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]> {
    yield* this.queryRange({ tsFrom: q.tsFrom, tsTo: q.tsTo, symbols: [q.symbol] });
  }
}

export class FixtureDataPort implements BacktesterDataPort {
  constructor(private readonly fixturesDir: string) {}

  private async loadFixture(datasetRef: string): Promise<FixtureFile | undefined> {
    try {
      const raw = await readFile(resolve(this.fixturesDir, `${datasetRef}.json`), 'utf8');
      const parsed = JSON.parse(raw) as FixtureFile;
      return { ...parsed, rows: sortRows(parsed.rows) };
    } catch {
      return undefined;
    }
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    let files: string[];
    try {
      files = (await readdir(this.fixturesDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: DatasetDescriptor[] = [];
    for (const file of files.sort()) {
      const fixture = await this.loadFixture(file.replace(/\.json$/, ''));
      if (!fixture || fixture.rows.length === 0) continue;
      const symbols = [...new Set(fixture.rows.map((r) => r.symbol))].sort();
      const tss = fixture.rows.map((r) => r.minute_ts);
      out.push({
        datasetRef: fixture.datasetRef,
        symbols,
        timeframe: fixture.timeframe,
        period: {
          from: new Date(Math.min(...tss)).toISOString(),
          to: new Date(Math.max(...tss) + 60_000).toISOString(),
        },
        rowCount: fixture.rows.length,
      });
    }
    return out;
  }

  async openDataset(datasetRef: string): Promise<HistoricalDatasetReader | undefined> {
    const fixture = await this.loadFixture(datasetRef);
    if (!fixture) return undefined;
    return new FixtureReader(fixture.rows);
  }
}

/** A fully materialized, per-symbol minute-indexed view consumed by the runner. */
export interface MaterializedDataset {
  readonly datasetRef: string;
  symbols(): string[];
  candles(symbol: string): ReaderRow[];
  rows(): ReaderRow[];
}

/** Stream all batches from a reader into a per-symbol materialized dataset (sorted by minute_ts). */
export async function materialize(
  reader: HistoricalDatasetReader,
  datasetRef: string,
  query: RangeQuery,
): Promise<MaterializedDataset> {
  const bySymbol = new Map<string, ReaderRow[]>();
  for await (const batch of reader.queryRange(query)) {
    for (const row of batch) {
      const list = bySymbol.get(row.symbol);
      if (list) list.push(row);
      else bySymbol.set(row.symbol, [row]);
    }
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.minute_ts - b.minute_ts);
  return {
    datasetRef,
    symbols: () => [...bySymbol.keys()].sort(),
    candles: (symbol) => bySymbol.get(symbol) ?? [],
    rows: () =>
      [...bySymbol.keys()]
        .sort()
        .flatMap((s) => bySymbol.get(s) ?? []),
  };
}

/** Content fingerprint of the materialized data — detects canonical-data drift between fetch & replay. */
export function datasetFingerprint(dataset: MaterializedDataset): string {
  return contentRef(dataset.rows());
}
