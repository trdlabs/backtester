// MockPlatformDataPort — BacktesterDataPort backed by trading-mock-platform's
// /historical/* surface (Phase 009). Fetches bars, funding, and OI separately,
// then merges them into CanonicalRow / ReaderRow for the backtester.

import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

// ── Wire types: mirrors trading-mock-platform contract (no cross-repo import) ──

interface OhlcvBar {
  readonly tsMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface FundingEntry {
  readonly tsMs: number;
  readonly symbol: string;
  readonly rate: number;
}

interface OpenInterestEntry {
  readonly tsMs: number;
  readonly symbol: string;
  readonly openInterestUsd: number;
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
  readonly symbols: readonly string[];
  readonly timeframes: readonly string[];
  readonly resources: readonly ResourceDescriptor[];
}

// ── Public API ────────────────────────────────────────────────────────────────

type FetchLike = typeof globalThis.fetch;

export interface MockPlatformDataPortOptions {
  readonly baseUrl: string;
  /** Injectable fetch implementation (for tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchLike;
  /** Rows per page when fetching bars. Default 500. */
  readonly pageLimit?: number;
  /** Bearer token for mock-platform auth (MOCK_OPS_TOKENS-verified). */
  readonly opsToken?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msToISO(ms: number): string {
  return new Date(ms).toISOString();
}

// ── MockPlatformReader ────────────────────────────────────────────────────────

class MockPlatformReader implements HistoricalDatasetReader {
  constructor(
    private readonly base: string,
    private readonly symbol: string,
    private readonly timeframe: string,
    private readonly pageLimit: number,
    private readonly fetchImpl: FetchLike,
  ) {}

  async *queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]> {
    const [bars, fundingMap, oiMap] = await Promise.all([
      this.fetchAllBars(q.tsFrom, q.tsTo),
      this.fetchFundingMap(q.tsFrom, q.tsTo),
      this.fetchOIMap(q.tsFrom, q.tsTo),
    ]);

    const rows: ReaderRow[] = bars.map((bar) => ({
      symbol:                this.symbol,
      minute_ts:             bar.tsMs,
      open:                  bar.open,
      high:                  bar.high,
      low:                   bar.low,
      close:                 bar.close,
      volume:                bar.volume,
      turnover:              bar.close * bar.volume,
      oi_total_usd:          oiMap.get(bar.tsMs) ?? null,
      has_oi:                oiMap.has(bar.tsMs),
      funding_rate:          fundingMap.get(bar.tsMs) ?? null,
      has_funding:           fundingMap.has(bar.tsMs),
      liq_long_usd:          null,
      liq_short_usd:         null,
      has_liquidations:      false,
      taker_buy_volume_usd:  null,
      taker_sell_volume_usd: null,
      has_taker_flow:        false,
    }));

    for (let i = 0; i < rows.length; i += this.pageLimit) {
      const batch = rows.slice(i, i + this.pageLimit);
      if (batch.length > 0) yield batch;
    }
  }

  async *queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]> {
    yield* this.queryRange({ tsFrom: q.tsFrom, tsTo: q.tsTo, symbols: [q.symbol] });
  }

  private async fetchAllBars(fromMs: number, toMs: number): Promise<OhlcvBar[]> {
    const all: OhlcvBar[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = new URLSearchParams({
        symbol:    this.symbol,
        timeframe: this.timeframe,
        fromMs:    String(fromMs),
        toMs:      String(toMs),
        limit:     String(this.pageLimit),
      });
      if (cursor) params.set('cursor', cursor);

      const res = await this.fetchImpl(`${this.base}/historical/bars?${params.toString()}`);
      if (!res.ok) throw new Error(`mock-platform /historical/bars: HTTP ${res.status}`);
      const page = (await res.json()) as PageEnvelope<OhlcvBar>;
      all.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return all;
  }

  private async fetchFundingMap(fromMs: number, toMs: number): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
      let cursor: string | null = null;
      for (;;) {
        const params = new URLSearchParams({
          symbol: this.symbol,
          fromMs: String(fromMs),
          toMs:   String(toMs),
          limit:  String(this.pageLimit),
        });
        if (cursor) params.set('cursor', cursor);

        const res = await this.fetchImpl(`${this.base}/historical/funding?${params.toString()}`);
        if (!res.ok) {
          console.warn(`mock-platform /historical/funding: HTTP ${res.status} — skipping funding data`);
          break;
        }
        const page = (await res.json()) as PageEnvelope<FundingEntry>;
        for (const e of page.items) map.set(e.tsMs, e.rate);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      console.warn('mock-platform funding fetch failed — continuing without funding:', err);
    }
    return map;
  }

  private async fetchOIMap(fromMs: number, toMs: number): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
      let cursor: string | null = null;
      for (;;) {
        const params = new URLSearchParams({
          symbol: this.symbol,
          fromMs: String(fromMs),
          toMs:   String(toMs),
          limit:  String(this.pageLimit),
        });
        if (cursor) params.set('cursor', cursor);

        const res = await this.fetchImpl(`${this.base}/historical/open-interest?${params.toString()}`);
        if (!res.ok) {
          console.warn(`mock-platform /historical/open-interest: HTTP ${res.status} — skipping OI data`);
          break;
        }
        const page = (await res.json()) as PageEnvelope<OpenInterestEntry>;
        for (const e of page.items) map.set(e.tsMs, e.openInterestUsd);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) {
      console.warn('mock-platform OI fetch failed — continuing without OI:', err);
    }
    return map;
  }
}

// ── MockPlatformDataPort ──────────────────────────────────────────────────────

export class MockPlatformDataPort implements BacktesterDataPort {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly pageLimit: number;

  constructor(opts: MockPlatformDataPortOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    const rawFetch = opts.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = opts.opsToken
      ? (url, init) => rawFetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${opts.opsToken}` } })
      : rawFetch;
    this.pageLimit = opts.pageLimit ?? 500;
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const res = await this.fetchImpl(`${this.base}/historical/coverage`);
    if (!res.ok) throw new Error(`mock-platform /historical/coverage: HTTP ${res.status}`);
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

    if (!descriptor.symbols.includes(symbol)) return undefined;
    if (!descriptor.timeframes.includes(timeframe)) return undefined;

    const barsResource = descriptor.resources.find((r) => r.name === 'bars');
    if (barsResource?.availability === 'unavailable') return undefined;

    return new MockPlatformReader(this.base, symbol, timeframe, this.pageLimit, this.fetchImpl);
  }
}
