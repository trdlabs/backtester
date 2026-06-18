import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlatformDataPort } from '../src/data/mock-platform-data-port';

// ── Fixture data ──────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const ONE_HOUR = 3_600_000;

interface Bar { tsMs: number; open: number; high: number; low: number; close: number; volume: number; }
interface Funding { tsMs: number; symbol: string; rate: number; }
interface OI { tsMs: number; symbol: string; openInterestUsd: number; }
interface PageResult<T> { items: T[]; nextCursor: string | null; asOf: number; window: object; freshness: string; }

const BARS_1H: Bar[] = Array.from({ length: 5 }, (_, i) => ({
  tsMs: T0 + i * ONE_HOUR,
  open:   50000 + i * 10,
  high:   50100 + i * 10,
  low:    49900 + i * 10,
  close:  50050 + i * 10,
  volume: 10 + i,
}));

const BARS_1D: Bar[] = [
  { tsMs: T0,                    open: 50000, high: 51000, low: 49000, close: 50500, volume: 1000 },
  { tsMs: T0 + 86_400_000,       open: 50500, high: 51500, low: 49500, close: 51000, volume: 1200 },
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

// ── Cursor helpers (matches trading-mock-platform encoding) ───────────────────

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset: number }).offset;
  } catch {
    return 0;
  }
}

function paginate<T>(items: T[], cursor: string | undefined, limit: number): PageResult<T> {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, nextCursor: next, asOf: Date.now(), window: {}, freshness: 'fresh' };
}

// ── Fixture server ────────────────────────────────────────────────────────────

interface FixtureServerOpts {
  barsUnavailable?: boolean;
  serverPageLimit?: number;
}

function buildFixtureServer(opts: FixtureServerOpts = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const PL = opts.serverPageLimit ?? 100;

  app.get('/historical/coverage', (_req, reply) => {
    if (opts.barsUnavailable) {
      return reply.send({
        entries: [], symbols: [], timeframes: [], availability: 'unavailable', asOf: Date.now(),
      });
    }
    return reply.send({
      entries: [
        { symbol: 'BTCUSDT', timeframe: '1h', fromMs: BARS_1H[0]!.tsMs, toMs: BARS_1H[4]!.tsMs, barCount: 5, availability: 'available' },
        { symbol: 'BTCUSDT', timeframe: '1d', fromMs: BARS_1D[0]!.tsMs, toMs: BARS_1D[1]!.tsMs, barCount: 2, availability: 'available' },
      ],
      symbols: ['BTCUSDT'],
      timeframes: ['1h', '1d'],
      availability: 'available',
      asOf: Date.now(),
    });
  });

  app.get('/historical/discover', (_req, reply) => {
    return reply.send({
      historicalContractVersion: 'historical.1',
      capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
      resources: [
        {
          name: 'bars',
          availability: opts.barsUnavailable ? 'unavailable' : 'available',
          supportedFilters: ['symbol', 'timeframe', 'fromMs', 'toMs'],
          pagination: { cursor: true, maxPageItems: PL },
          fields: [],
        },
        { name: 'funding',        availability: 'available', supportedFilters: [], pagination: null, fields: [] },
        { name: 'open-interest',  availability: 'available', supportedFilters: [], pagination: null, fields: [] },
      ],
      symbols: ['BTCUSDT'],
      timeframes: ['1h', '1d'],
    });
  });

  app.get('/historical/bars', (req, reply) => {
    const q = req.query as { timeframe?: string; fromMs?: string; toMs?: string; cursor?: string; limit?: string };
    const src = q.timeframe === '1d' ? BARS_1D : BARS_1H;
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs   = q.toMs   ? Number(q.toMs)   : Infinity;
    const filtered = src.filter(b => b.tsMs >= fromMs && b.tsMs <= toMs);
    const limit = q.limit ? Math.min(Number(q.limit), PL) : PL;
    return reply.send(paginate(filtered, q.cursor, limit));
  });

  app.get('/historical/funding', (req, reply) => {
    const q = req.query as { fromMs?: string; toMs?: string; cursor?: string };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs   = q.toMs   ? Number(q.toMs)   : Infinity;
    return reply.send(paginate(FUNDING.filter(f => f.tsMs >= fromMs && f.tsMs <= toMs), q.cursor, PL));
  });

  app.get('/historical/open-interest', (req, reply) => {
    const q = req.query as { fromMs?: string; toMs?: string; cursor?: string };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs   = q.toMs   ? Number(q.toMs)   : Infinity;
    return reply.send(paginate(OI_DATA.filter(o => o.tsMs >= fromMs && o.tsMs <= toMs), q.cursor, PL));
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

  afterAll(async () => {
    await server.close();
  });

  describe('listDatasets()', () => {
    it('returns one descriptor per symbol+timeframe', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const datasets = await port.listDatasets();

      expect(datasets).toHaveLength(2);
      expect(datasets.find(d => d.datasetRef === 'BTCUSDT:1h')).toMatchObject({
        symbols:   ['BTCUSDT'],
        timeframe: '1h',
        rowCount:  5,
      });
      expect(datasets.find(d => d.datasetRef === 'BTCUSDT:1d')).toMatchObject({
        symbols:   ['BTCUSDT'],
        timeframe: '1d',
        rowCount:  2,
      });
    });

    it('returns [] when coverage reports unavailable', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ barsUnavailable: true });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new MockPlatformDataPort({ baseUrl: url });
        expect(await port.listDatasets()).toEqual([]);
      } finally {
        await s?.close();
      }
    });
  });

  describe('openDataset()', () => {
    it('returns a reader for BTCUSDT:1h', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:1h')).toBeDefined();
    });

    it('returns a reader for BTCUSDT:1d', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:1d')).toBeDefined();
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
      } finally {
        await s?.close();
      }
    });

    it('returns undefined for malformed ref (no colon)', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT1h')).toBeUndefined();
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
        symbol:        'BTCUSDT',
        minute_ts:     BARS_1H[0]!.tsMs,
        open:          50000,
        has_taker_flow: false,
        taker_buy_volume_usd:  null,
        taker_sell_volume_usd: null,
      });
    });

    it('sets has_funding and funding_rate correctly (only bars[0,2,4] have funding)', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: Array<{ has_funding: boolean; funding_rate: number | null }> = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...(batch as typeof rows));
      }
      expect(rows[0]!.has_funding).toBe(true);
      expect(rows[0]!.funding_rate).toBeCloseTo(0.0001);
      expect(rows[1]!.has_funding).toBe(false);
      expect(rows[1]!.funding_rate).toBeNull();
      expect(rows[2]!.has_funding).toBe(true);
      expect(rows[2]!.funding_rate).toBeCloseTo(0.0002);
      expect(rows[4]!.has_funding).toBe(true);
      expect(rows[4]!.funding_rate).toBeCloseTo(0.0003);
    });

    it('sets has_oi and oi_total_usd correctly (only bars[0,2,4] have OI)', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: Array<{ has_oi: boolean; oi_total_usd: number | null }> = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...(batch as typeof rows));
      }
      expect(rows[0]!.has_oi).toBe(true);
      expect(rows[0]!.oi_total_usd).toBe(5_000_000_000);
      expect(rows[1]!.has_oi).toBe(false);
      expect(rows[1]!.oi_total_usd).toBeNull();
      expect(rows[4]!.oi_total_usd).toBe(5_200_000_000);
    });

    it('computes turnover as close * volume', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: Array<{ turnover: number; close: number; volume: number }> = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) {
        rows.push(...(batch as typeof rows));
      }
      for (const row of rows) {
        expect(row.turnover).toBeCloseTo(row.close * row.volume);
      }
    });

    it('filters by tsFrom/tsTo (only bars[1..3])', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rows: Array<{ minute_ts: number }> = [];
      for await (const batch of reader!.queryRange({
        tsFrom: BARS_1H[1]!.tsMs,
        tsTo:   BARS_1H[3]!.tsMs,
      })) {
        rows.push(...(batch as typeof rows));
      }
      expect(rows).toHaveLength(3);
      expect(rows[0]!.minute_ts).toBe(BARS_1H[1]!.tsMs);
      expect(rows[2]!.minute_ts).toBe(BARS_1H[3]!.tsMs);
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
      } finally {
        await s?.close();
      }
    });
  });

  describe('queryOneSymbolTimeSeries()', () => {
    it('returns same rows as queryRange', async () => {
      const port = new MockPlatformDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1h');
      const rangeRows: unknown[] = [];
      const tsRows: unknown[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Infinity })) rangeRows.push(...batch);
      for await (const batch of reader!.queryOneSymbolTimeSeries({ symbol: 'BTCUSDT', tsFrom: 0, tsTo: Infinity })) tsRows.push(...batch);
      expect(tsRows).toHaveLength(rangeRows.length);
    });
  });
});
