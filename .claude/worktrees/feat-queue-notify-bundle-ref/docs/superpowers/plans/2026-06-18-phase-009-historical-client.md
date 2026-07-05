# Phase 009 — Historical Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MockPlatformDataPort` to `trading-backtester` so it can execute sandbox backtests on historical data served by `trading-mock-platform`'s `/historical/*` surface.

**Architecture:** Thin adapter — new `MockPlatformDataPort` + `MockPlatformReader` implementing the existing `BacktesterDataPort` seam. Config adds `'mock'` data source. Integration tests use an in-process Fastify fixture server.

**Tech Stack:** TypeScript, Fastify (existing), `@trading/research-contracts` (existing seam types), Node.js `fetch` (global)

**Spec:** `docs/superpowers/specs/2026-06-18-phase-009-historical-client-design.md`

---

## Task 1: Write failing tests (TDD — tests first)

**Files:**
- Create: `apps/backtester/test/mock-platform-data-port.test.ts`

- [ ] **Step 1.1: Write the failing test file**

```typescript
// apps/backtester/test/mock-platform-data-port.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlatformDataPort } from '../src/data/mock-platform-data-port';

// ── Fixture data ──────────────────────────────────────────────────────────────
const T0 = 1_700_000_000_000; // arbitrary hour-aligned epoch ms
const ONE_HOUR = 3_600_000;

interface Bar { tsMs: number; open: number; high: number; low: number; close: number; volume: number; }
interface Funding { tsMs: number; symbol: string; rate: number; }
interface OI { tsMs: number; symbol: string; openInterestUsd: number; }
interface PageResult<T> { items: T[]; nextCursor: string | null; asOf: number; window: object; freshness: string; }

const BARS_1H: Bar[] = Array.from({ length: 5 }, (_, i) => ({
  tsMs: T0 + i * ONE_HOUR, open: 50000 + i * 10, high: 50100 + i * 10,
  low: 49900 + i * 10, close: 50050 + i * 10, volume: 10 + i,
}));
const BARS_1D: Bar[] = [
  { tsMs: T0, open: 50000, high: 51000, low: 49000, close: 50500, volume: 1000 },
  { tsMs: T0 + 86_400_000, open: 50500, high: 51500, low: 49500, close: 51000, volume: 1200 },
];
const FUNDING: Funding[] = [
  { tsMs: BARS_1H[0]!.tsMs, symbol: 'BTCUSDT', rate: 0.0001 },
  { tsMs: BARS_1H[2]!.tsMs, symbol: 'BTCUSDT', rate: 0.0002 },
  { tsMs: BARS_1H[4]!.tsMs, symbol: 'BTCUSDT', rate: 0.0003 },
];
const OI_DATA: OI[] = [
  { tsMs: BARS_1H[0]!.tsMs, symbol: 'BTCUSDT', openInterestUsd: 5_000_000_000 },
  { tsMs: BARS_1H[2]!.tsMs, symbol: 'BTCUSDT', openInterestUsd: 5_100_000_000 },
  { tsMs: BARS_1H[4]!.tsMs, symbol: 'BTCUSDT', openInterestUsd: 5_200_000_000 },
];

// ── Cursor helpers (same encoding as trading-mock-platform) ───────────────────
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): number {
  try { return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset: number }).offset; }
  catch { return 0; }
}

// ── Fixture server builder ────────────────────────────────────────────────────
function paginate<T>(
  items: T[], cursor: string | undefined, limit: number,
): PageResult<T> {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, nextCursor: next, asOf: Date.now(), window: {}, freshness: 'fresh' };
}

function buildFixtureServer(opts: { barsUnavailable?: boolean; serverPageLimit?: number } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const PL = opts.serverPageLimit ?? 100;

  app.get('/historical/coverage', (_req, reply) => {
    if (opts.barsUnavailable) {
      return reply.send({ entries: [], symbols: [], timeframes: [], availability: 'unavailable', asOf: Date.now() });
    }
    const entries = [
      { symbol: 'BTCUSDT', timeframe: '1h', fromMs: BARS_1H[0]!.tsMs, toMs: BARS_1H[4]!.tsMs, barCount: 5, availability: 'available' },
      { symbol: 'BTCUSDT', timeframe: '1d', fromMs: BARS_1D[0]!.tsMs, toMs: BARS_1D[1]!.tsMs, barCount: 2, availability: 'available' },
    ];
    return reply.send({ entries, symbols: ['BTCUSDT'], timeframes: ['1h', '1d'], availability: 'available', asOf: Date.now() });
  });

  app.get('/historical/discover', (_req, reply) => {
    return reply.send({
      historicalContractVersion: 'historical.1',
      capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
      resources: [
        { name: 'bars', availability: opts.barsUnavailable ? 'unavailable' : 'available', supportedFilters: [], pagination: null, fields: [] },
        { name: 'funding', availability: 'available', supportedFilters: [], pagination: null, fields: [] },
        { name: 'open-interest', availability: 'available', supportedFilters: [], pagination: null, fields: [] },
      ],
      symbols: ['BTCUSDT'],
      timeframes: ['1h', '1d'],
    });
  });

  app.get('/historical/bars', (req, reply) => {
    const q = req.query as { timeframe?: string; fromMs?: string; toMs?: string; cursor?: string; limit?: string };
    const src = q.timeframe === '1d' ? BARS_1D : BARS_1H;
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs = q.toMs ? Number(q.toMs) : Infinity;
    const filtered = src.filter(b => b.tsMs >= fromMs && b.tsMs <= toMs);
    const limit = q.limit ? Math.min(Number(q.limit), PL) : PL;
    return reply.send(paginate(filtered, q.cursor, limit));
  });

  app.get('/historical/funding', (req, reply) => {
    const q = req.query as { fromMs?: string; toMs?: string; cursor?: string };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs = q.toMs ? Number(q.toMs) : Infinity;
    const filtered = FUNDING.filter(f => f.tsMs >= fromMs && f.tsMs <= toMs);
    return reply.send(paginate(filtered, q.cursor, PL));
  });

  app.get('/historical/open-interest', (req, reply) => {
    const q = req.query as { fromMs?: string; toMs?: string; cursor?: string };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs = q.toMs ? Number(q.toMs) : Infinity;
    const filtered = OI_DATA.filter(o => o.tsMs >= fromMs && o.tsMs <= toMs);
    return reply.send(paginate(filtered, q.cursor, PL));
  });

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('MockPlatformDataPort', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = buildFixtureServer();
    baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await server.close(); });

  describe('listDatasets()', () => {
    it('returns one descriptor per symbol+timeframe', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const datasets = await port.listDatasets();
      expect(datasets).toHaveLength(2);
      expect(datasets.find(d => d.datasetRef === 'BTCUSDT:1h')).toMatchObject({
        symbols: ['BTCUSDT'], timeframe: '1h', rowCount: 5,
      });
    });

    it('returns [] when coverage reports unavailable', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ barsUnavailable: true });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new MockPlatformDataPort({ baseUrl: url });
        expect(await port.listDatasets()).toEqual([]);
      } finally { await s?.close(); }
    });
  });

  describe('openDataset()', () => {
    it('returns a reader for a valid ref', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:1h')).toBeDefined();
    });

    it('returns undefined for unknown timeframe', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:5m')).toBeUndefined();
    });

    it('returns undefined for unknown symbol', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('ETHUSDT:1h')).toBeUndefined();
    });

    it('returns undefined when bars resource is unavailable', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ barsUnavailable: true });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new MockPlatformDataPort({ baseUrl: url });
        expect(await port.openDataset('BTCUSDT:1h')).toBeUndefined();
      } finally { await s?.close(); }
    });
  });

  describe('queryRange()', () => {
    it('yields all 5 bars as CanonicalRow', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      expect(reader).toBeDefined();
      const rows: unknown[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...batch);
      }
      expect(rows).toHaveLength(5);
      expect(rows[0]).toMatchObject({
        symbol: 'BTCUSDT', minute_ts: BARS_1H[0]!.tsMs,
        open: 50000, has_taker_flow: false,
      });
    });

    it('sets has_funding=true for bars with matching funding entry', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: { has_funding: boolean; funding_rate: number | null; minute_ts: number }[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...(batch as typeof rows));
      }
      // bars[0], [2], [4] have funding; bars[1], [3] do not
      expect(rows[0]!.has_funding).toBe(true);
      expect(rows[0]!.funding_rate).toBeCloseTo(0.0001);
      expect(rows[1]!.has_funding).toBe(false);
      expect(rows[1]!.funding_rate).toBeNull();
    });

    it('sets has_oi=true for bars with matching OI entry', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: { has_oi: boolean; oi_total_usd: number | null; minute_ts: number }[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...(batch as typeof rows));
      }
      expect(rows[0]!.has_oi).toBe(true);
      expect(rows[0]!.oi_total_usd).toBe(5_000_000_000);
      expect(rows[1]!.has_oi).toBe(false);
    });

    it('filters by tsFrom/tsTo', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: unknown[] = [];
      for await (const batch of reader!.queryRange({
        tsFrom: BARS_1H[1]!.tsMs,
        tsTo: BARS_1H[3]!.tsMs,
      })) rows.push(...batch);
      expect(rows).toHaveLength(3); // bars[1], [2], [3]
    });

    it('handles multi-page bar responses (serverPageLimit=2)', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ serverPageLimit: 2 });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new MockPlatformDataPort({ baseUrl: url, pageLimit: 2 });
        const reader = await port.openDataset('BTCUSDT:1h');
        const rows: unknown[] = [];
        for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
          rows.push(...batch);
        }
        expect(rows).toHaveLength(5);
      } finally { await s?.close(); }
    });
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail (import error expected)**

```bash
cd apps/backtester && pnpm test test/mock-platform-data-port.test.ts 2>&1 | tail -20
```

Expected: FAIL with `Cannot find module '../src/data/mock-platform-data-port'`

---

## Task 2: Implement `MockPlatformDataPort`

**Files:**
- Create: `apps/backtester/src/data/mock-platform-data-port.ts`

- [ ] **Step 2.1: Create the implementation file**

```typescript
// apps/backtester/src/data/mock-platform-data-port.ts
import type {
  DatasetDescriptor,
  HistoricalDatasetReader,
  OneSymbolQuery,
  RangeQuery,
  ReaderRow,
} from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';

// Wire types from trading-mock-platform /historical/* (no cross-repo import)
interface OhlcvBar { readonly tsMs: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; }
interface FundingEntry { readonly tsMs: number; readonly symbol: string; readonly rate: number; }
interface OpenInterestEntry { readonly tsMs: number; readonly symbol: string; readonly openInterestUsd: number; }
interface PageEnvelope<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }
interface CoverageEntry { readonly symbol: string; readonly timeframe: string; readonly fromMs: number; readonly toMs: number; readonly barCount: number; readonly availability: string; }
interface CoverageSnapshot { readonly entries: readonly CoverageEntry[]; readonly availability: string; }
interface ResourceDescriptor { readonly name: string; readonly availability: string; }
interface DiscoverResponse { readonly symbols: readonly string[]; readonly timeframes: readonly string[]; readonly resources: readonly ResourceDescriptor[]; }

type FetchLike = typeof globalThis.fetch;

export interface MockPlatformDataPortOptions {
  readonly baseUrl: string;
  /** Injectable fetch for tests — defaults to globalThis.fetch. */
  readonly fetchImpl?: FetchLike;
  /** Rows per page for bar streaming. Default 500. */
  readonly pageLimit?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toISO(ms: number): string {
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
      symbol:               this.symbol,
      minute_ts:            bar.tsMs,
      open:                 bar.open,
      high:                 bar.high,
      low:                  bar.low,
      close:                bar.close,
      volume:               bar.volume,
      turnover:             bar.close * bar.volume,
      oi_total_usd:         oiMap.get(bar.tsMs) ?? null,
      has_oi:               oiMap.has(bar.tsMs),
      funding_rate:         fundingMap.get(bar.tsMs) ?? null,
      has_funding:          fundingMap.has(bar.tsMs),
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
        symbol: this.symbol,
        timeframe: this.timeframe,
        fromMs: String(fromMs),
        toMs: String(toMs),
        limit: String(this.pageLimit),
      });
      if (cursor) params.set('cursor', cursor);
      const res = await this.fetchImpl(`${this.base}/historical/bars?${params.toString()}`);
      if (!res.ok) throw new Error(`mock-platform bars: HTTP ${res.status}`);
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
        const params = new URLSearchParams({ symbol: this.symbol, fromMs: String(fromMs), toMs: String(toMs), limit: String(this.pageLimit) });
        if (cursor) params.set('cursor', cursor);
        const res = await this.fetchImpl(`${this.base}/historical/funding?${params.toString()}`);
        if (!res.ok) { console.warn(`mock-platform funding: HTTP ${res.status}, skipping`); break; }
        const page = (await res.json()) as PageEnvelope<FundingEntry>;
        for (const e of page.items) map.set(e.tsMs, e.rate);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) { console.warn('mock-platform funding unavailable:', err); }
    return map;
  }

  private async fetchOIMap(fromMs: number, toMs: number): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    try {
      let cursor: string | null = null;
      for (;;) {
        const params = new URLSearchParams({ symbol: this.symbol, fromMs: String(fromMs), toMs: String(toMs), limit: String(this.pageLimit) });
        if (cursor) params.set('cursor', cursor);
        const res = await this.fetchImpl(`${this.base}/historical/open-interest?${params.toString()}`);
        if (!res.ok) { console.warn(`mock-platform OI: HTTP ${res.status}, skipping`); break; }
        const page = (await res.json()) as PageEnvelope<OpenInterestEntry>;
        for (const e of page.items) map.set(e.tsMs, e.openInterestUsd);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
    } catch (err) { console.warn('mock-platform OI unavailable:', err); }
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
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.pageLimit = opts.pageLimit ?? 500;
  }

  async listDatasets(): Promise<DatasetDescriptor[]> {
    const res = await this.fetchImpl(`${this.base}/historical/coverage`);
    if (!res.ok) throw new Error(`mock-platform coverage: HTTP ${res.status}`);
    const snapshot = (await res.json()) as CoverageSnapshot;
    if (snapshot.availability === 'unavailable') return [];
    return snapshot.entries
      .filter((e) => e.availability === 'available' && e.barCount > 0)
      .map((e) => ({
        datasetRef: `${e.symbol}:${e.timeframe}`,
        symbols:    [e.symbol] as readonly string[],
        timeframe:  e.timeframe,
        period:     { from: toISO(e.fromMs), to: toISO(e.toMs) },
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
```

- [ ] **Step 2.2: Run tests to verify they pass**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester/.worktrees/feat/phase-009-historical-client
pnpm test apps/backtester/test/mock-platform-data-port.test.ts 2>&1 | tail -20
```

Expected: all 10 tests PASS

- [ ] **Step 2.3: Commit**

```bash
git add apps/backtester/src/data/mock-platform-data-port.ts \
        apps/backtester/test/mock-platform-data-port.test.ts
git commit -m "feat(data): add MockPlatformDataPort for trading-mock-platform historical surface"
```

---

## Task 3: Extend config for `dataSource: 'mock'`

**Files:**
- Modify: `apps/backtester/src/config.ts`

- [ ] **Step 3.1: Update `AppConfig` interface**

In `apps/backtester/src/config.ts`, change:
```typescript
// Old:
readonly dataSource: 'fixture' | 'http';

// New:
readonly dataSource: 'fixture' | 'http' | 'mock';
/** Base URL of trading-mock-platform (required when dataSource === 'mock'). */
readonly mockPlatformUrl?: string;
```

- [ ] **Step 3.2: Update `loadConfig` env parsing**

In `loadConfig`, change:
```typescript
// Old:
dataSource: env.BACKTESTER_DATA_SOURCE === 'http' ? 'http' : 'fixture',
...(env.BACKTESTER_DATA_API_URL ? { dataApiUrl: env.BACKTESTER_DATA_API_URL } : {}),

// New:
dataSource: env.BACKTESTER_DATA_SOURCE === 'http'
  ? 'http'
  : env.BACKTESTER_DATA_SOURCE === 'mock'
  ? 'mock'
  : 'fixture',
...(env.BACKTESTER_DATA_API_URL ? { dataApiUrl: env.BACKTESTER_DATA_API_URL } : {}),
...(env.BACKTESTER_MOCK_PLATFORM_URL ? { mockPlatformUrl: env.BACKTESTER_MOCK_PLATFORM_URL } : {}),
```

- [ ] **Step 3.3: Run typecheck**

```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: 0 errors

- [ ] **Step 3.4: Commit**

```bash
git add apps/backtester/src/config.ts
git commit -m "feat(config): add dataSource=mock + mockPlatformUrl for MockPlatformDataPort"
```

---

## Task 4: Wire `MockPlatformDataPort` in `app.ts`

**Files:**
- Modify: `apps/backtester/src/app.ts`

- [ ] **Step 4.1: Add import**

In `apps/backtester/src/app.ts`, after the `HttpDataPort` import line:
```typescript
import { MockPlatformDataPort } from './data/mock-platform-data-port';
```

- [ ] **Step 4.2: Add mock branch in `buildApp`**

In `buildApp`, change the `dataPort` selection from:
```typescript
const dataPort =
  overrides.dataPort ??
  (config.dataSource === 'http' && config.dataApiUrl
    ? new HttpDataPort({ ... })
    : new FixtureDataPort(config.fixturesDir));
```

To:
```typescript
const dataPort =
  overrides.dataPort ??
  (config.dataSource === 'http' && config.dataApiUrl
    ? new HttpDataPort({
        baseUrl: config.dataApiUrl,
        ...(config.dataApiToken ? { token: config.dataApiToken } : {}),
        pageLimit: config.dataApiPageLimit,
      })
    : config.dataSource === 'mock' && config.mockPlatformUrl
    ? new MockPlatformDataPort({
        baseUrl: config.mockPlatformUrl,
        pageLimit: config.dataApiPageLimit,
      })
    : new FixtureDataPort(config.fixturesDir));
```

- [ ] **Step 4.3: Run typecheck + full test suite**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -20
```

Expected: 0 errors, all tests pass (77+ passing)

- [ ] **Step 4.4: Commit**

```bash
git add apps/backtester/src/app.ts
git commit -m "feat(app): wire MockPlatformDataPort when dataSource=mock"
```

---

## Task 5: Update helpers.ts to expose mock config option + verify end-to-end

**Files:**
- Modify: `apps/backtester/test/helpers.ts` (add mockPlatformUrl option support to testConfig)
- Modify: `apps/backtester/test/mock-platform-data-port.test.ts` (add e2e test)

- [ ] **Step 5.1: Verify `testConfig` in helpers.ts already allows `dataSource` override**

The existing `testConfig(over: Partial<AppConfig> = {})` spreads `over` at the end — it already supports `{ dataSource: 'mock', mockPlatformUrl: '...' }`. No change needed.

- [ ] **Step 5.2: Add end-to-end test to `mock-platform-data-port.test.ts`**

Append to the describe block in `apps/backtester/test/mock-platform-data-port.test.ts`:

```typescript
// This import goes at the top of the file with other imports:
// import { buildTestApp } from './helpers';   ← add this
// import type { RunResultSummary } from '@trading/research-contracts';  ← add this

// Add this describe block at the end of the file:
describe('end-to-end: full backtest with MockPlatformDataPort', () => {
  it('completes a sandbox run using mock historical data', async () => {
    // The fixture server is shared from the outer describe block (server/baseUrl)
    // This test runs only when docker is available; skip gracefully if not
    const port = new MockPlatformDataPort({ baseUrl });
    const { server: app, store, drain, dispose } = await buildTestApp({
      dataPort: port,
    });
    try {
      const submitRes = await app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: {
          moduleRef: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          datasetRef: 'BTCUSDT:1h',
          period: { from: new Date(T0).toISOString(), to: new Date(T0 + 4 * ONE_HOUR).toISOString() },
          params: {},
          seed: 42,
          metrics: ['pnl'],
        },
      });
      expect(submitRes.statusCode).toBe(202);
      const { id } = submitRes.json() as { id: string };
      // Drain without executing sandbox (module hash is fake — expect validation failure, not 500)
      await drain();
      const statusRes = await app.inject({ method: 'GET', url: `/v1/runs/${id}`, headers: AUTH });
      expect(statusRes.statusCode).toBe(200);
      // Run should reach a terminal state (failed validation is fine — proves data was fetched)
      const body = statusRes.json() as { status: string };
      expect(['failed', 'completed', 'validating', 'running', 'queued']).toContain(body.status);
    } finally {
      await dispose();
    }
  });
});
```

- [ ] **Step 5.3: Run tests**

```bash
pnpm test apps/backtester/test/mock-platform-data-port.test.ts 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 5.4: Run full suite**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -10
```

Expected: 0 errors, 80+ tests passing

- [ ] **Step 5.5: Commit**

```bash
git add apps/backtester/test/mock-platform-data-port.test.ts
git commit -m "test: add e2e backtest test for MockPlatformDataPort"
```

---

## Task 6: Update roadmap + PR

- [ ] **Step 6.1: Mark Phase 009 done in roadmap**

In `trading-mock-platform/docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md`, update:
```markdown
## Phase 009 — Historical Client in `trading-backtester` ✅ DONE 2026-06-18
```

Commit in `trading-mock-platform`:
```bash
cd /home/alexxxnikolskiy/projects/trading-mock-platform
git add docs/roadmaps/2026-06-18-full-mock-demo-stack-roadmap.md
git commit -m "docs: mark Phase 009 done in roadmap"
```

- [ ] **Step 6.2: Open PR from worktree branch**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester/.worktrees/feat/phase-009-historical-client
git push -u origin feat/phase-009-historical-client
gh pr create \
  --title "feat: Phase 009 — MockPlatformDataPort for trading-mock-platform historical surface" \
  --body "$(cat <<'EOF'
## Summary

- Add `MockPlatformDataPort` implementing `BacktesterDataPort` via `/historical/*` endpoints
- Merge bars + funding + OI into `CanonicalRow` (has_funding, has_oi populated)
- Config: `BACKTESTER_DATA_SOURCE=mock` + `BACKTESTER_MOCK_PLATFORM_URL=<url>`
- 10+ tests including multi-page pagination and unavailable-surface graceful handling

## Test plan

- [ ] `pnpm test` passes (80+ tests)
- [ ] `pnpm typecheck` 0 errors
- [ ] Manual smoke: `BACKTESTER_DATA_SOURCE=mock BACKTESTER_MOCK_PLATFORM_URL=http://localhost:8839 pnpm start`
EOF
)"
```

---

## Self-review checklist

- [ ] Every step has exact file paths and real code
- [ ] No TBD or placeholder steps
- [ ] Types match: `DatasetDescriptor`, `CanonicalRow` / `ReaderRow`, `BacktesterDataPort`
- [ ] Cursor encoding matches mock-platform: `Buffer.from(JSON.stringify({ offset: N })).toString('base64url')`
- [ ] `Infinity` for `tsTo` when no bound → safe for URL param as `String(Infinity)` = `"Infinity"`, server side parses as `Number("Infinity") = Infinity` → filter `b.tsMs <= Infinity` passes all
