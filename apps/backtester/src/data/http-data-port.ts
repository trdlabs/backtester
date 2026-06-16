// platformDataClient — HTTP adapter (Slice 4). Implements the SAME seam as the in-process fixture
// reader (BacktesterDataPort / HistoricalDatasetReader), so the runner and worker are unchanged and
// the choice is purely config. The backtester gets historical data ONLY through this networked
// contract (no direct parquet/snapshot mount) and holds NO exchange credentials — at most a bearer
// token for the data API itself. Rows are fetched lazily one page at a time (cursor paging), so a
// full dataset never lands in memory and the consumer drives back-pressure.

import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  HistoricalRowsPage,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

export interface HttpDataPortOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly pageLimit?: number;
}

class HttpDatasetReader implements HistoricalDatasetReader {
  constructor(
    private readonly base: string,
    private readonly datasetRef: string,
    private readonly headers: Record<string, string>,
    private readonly pageLimit: number,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        datasetRef: this.datasetRef,
        tsFrom: String(q.tsFrom),
        tsTo: String(q.tsTo),
        limit: String(this.pageLimit),
      });
      if (q.symbols && q.symbols.length > 0) params.set('symbols', q.symbols.join(','));
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`${this.base}/data/v1/rows?${params.toString()}`, { headers: this.headers });
      if (!res.ok) throw new Error(`historical data API responded ${res.status} for ${this.datasetRef}`);
      const page = (await res.json()) as HistoricalRowsPage;
      if (page.rows.length > 0) yield page.rows as ReaderRow[];
      if (!page.nextCursor) return;
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

  constructor(opts: HttpDataPortOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
    this.pageLimit = opts.pageLimit ?? 1000;
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const res = await fetch(`${this.base}/data/v1/datasets`, { headers: this.headers });
    if (!res.ok) throw new Error(`historical data API responded ${res.status} for /datasets`);
    const body = (await res.json()) as { datasets: DatasetDescriptor[] };
    return body.datasets;
  }

  async openDataset(datasetRef: string): Promise<HistoricalDatasetReader | undefined> {
    const res = await fetch(`${this.base}/data/v1/datasets/${encodeURIComponent(datasetRef)}`, {
      headers: this.headers,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`historical data API responded ${res.status} for dataset ${datasetRef}`);
    return new HttpDatasetReader(this.base, datasetRef, this.headers, this.pageLimit);
  }
}
