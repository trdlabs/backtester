import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RowsDataPort } from '../src/data/rows-data-port';

// ── Fixture data: full CanonicalRowV2 rows (19 fields incl. schema_version) ─────

const T0 = 1_700_000_000_000;
const ONE_MIN = 60_000;

interface CanonicalRowV2 {
  schema_version: number;
  symbol: string;
  minute_ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  oi_total_usd: number | null;
  funding_rate: number | null;
  liq_long_usd: number | null;
  liq_short_usd: number | null;
  has_oi: boolean;
  has_funding: boolean;
  has_liquidations: boolean;
  taker_buy_volume_usd: number | null;
  taker_sell_volume_usd: number | null;
  has_taker_flow: boolean;
}

// ~6 rows, all kinds non-null (liq / taker / turnover / oi / funding present).
const ROWS: CanonicalRowV2[] = Array.from({ length: 6 }, (_, i) => ({
  schema_version:        2,
  symbol:                'BTCUSDT',
  minute_ts:             T0 + i * ONE_MIN,
  open:                  50000 + i * 10,
  high:                  50100 + i * 10,
  low:                   49900 + i * 10,
  close:                 50050 + i * 10,
  volume:                10 + i,
  turnover:              (50050 + i * 10) * (10 + i),
  oi_total_usd:          5_000_000_000 + i * 1_000_000,
  funding_rate:          0.0001 + i * 0.0001,
  liq_long_usd:          1_000 + i * 100,
  liq_short_usd:         2_000 + i * 100,
  has_oi:                true,
  has_funding:           true,
  has_liquidations:      true,
  taker_buy_volume_usd:  100_000 + i * 1_000,
  taker_sell_volume_usd: 90_000 + i * 1_000,
  has_taker_flow:        true,
}));

// ── Cursor helpers (matches trading-mock-platform encoding) ────────────────────

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

function paginate<T>(items: T[], cursor: string | undefined, limit: number): {
  items: T[]; nextCursor: string | null; asOf: number; window: object; freshness: string;
} {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, nextCursor: next, asOf: Date.now(), window: {}, freshness: 'fresh' };
}

// ── Fixture server ──────────────────────────────────────────────────────────────

interface FixtureServerOpts {
  contractVersion?: string;
  rowsAvailability?: string;
  omitRowsResource?: boolean;
  serverPageLimit?: number;
}

function buildFixtureServer(opts: FixtureServerOpts = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const PL = opts.serverPageLimit ?? 100;

  app.get('/historical/coverage', (_req, reply) => {
    return reply.send({
      entries: [
        { symbol: 'BTCUSDT', timeframe: '1m', fromMs: ROWS[0]!.minute_ts, toMs: ROWS[5]!.minute_ts, barCount: 6, availability: 'available' },
      ],
      symbols: ['BTCUSDT'],
      timeframes: ['1m'],
      availability: 'available',
      asOf: Date.now(),
    });
  });

  app.get('/historical/discover', (_req, reply) => {
    const resources = [
      { name: 'rows', availability: opts.rowsAvailability ?? 'available', supportedFilters: ['symbols', 'fromMs', 'toMs'], pagination: { cursor: true, maxPageItems: PL }, fields: [] },
    ].filter(() => !opts.omitRowsResource);
    return reply.send({
      historicalContractVersion: opts.contractVersion ?? 'historical.2',
      capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
      resources,
      symbols: ['BTCUSDT'],
      timeframes: ['1m'],
    });
  });

  app.get('/historical/rows', (req, reply) => {
    const q = req.query as { symbols?: string; fromMs?: string; toMs?: string; cursor?: string; limit?: string };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs   = q.toMs   ? Number(q.toMs)   : Infinity;
    const filtered = ROWS.filter(r => r.minute_ts >= fromMs && r.minute_ts <= toMs);
    const limit = q.limit ? Math.min(Number(q.limit), PL) : PL;
    return reply.send(paginate(filtered, q.cursor, limit));
  });

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RowsDataPort', () => {
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
    it('returns one dataset BTCUSDT:1m', async () => {
      const port = new RowsDataPort({ baseUrl });
      const datasets = await port.listDatasets();
      expect(datasets).toHaveLength(1);
      expect(datasets[0]).toMatchObject({
        datasetRef: 'BTCUSDT:1m',
        symbols:    ['BTCUSDT'],
        timeframe:  '1m',
        rowCount:   6,
      });
    });
  });

  describe('openDataset()', () => {
    it('returns a reader for BTCUSDT:1m', async () => {
      const port = new RowsDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:1m')).toBeDefined();
    });

    it('returns undefined for unknown timeframe', async () => {
      const port = new RowsDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT:5m')).toBeUndefined();
    });

    it('returns undefined for unknown symbol', async () => {
      const port = new RowsDataPort({ baseUrl });
      expect(await port.openDataset('ETHUSDT:1m')).toBeUndefined();
    });

    it('returns undefined for malformed ref (no colon)', async () => {
      const port = new RowsDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT1m')).toBeUndefined();
    });

    it('returns undefined when contract is not historical.2', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ contractVersion: 'historical.1' });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new RowsDataPort({ baseUrl: url });
        expect(await port.openDataset('BTCUSDT:1m')).toBeUndefined();
      } finally {
        await s?.close();
      }
    });

    it('returns undefined when rows resource is unavailable', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ rowsAvailability: 'unavailable' });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new RowsDataPort({ baseUrl: url });
        expect(await port.openDataset('BTCUSDT:1m')).toBeUndefined();
      } finally {
        await s?.close();
      }
    });

    it('returns undefined when rows resource is absent', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ omitRowsResource: true });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new RowsDataPort({ baseUrl: url });
        expect(await port.openDataset('BTCUSDT:1m')).toBeUndefined();
      } finally {
        await s?.close();
      }
    });
  });

  describe('queryRange()', () => {
    it('yields all 6 rows with full liq/taker/turnover preserved 1:1 (no recompute, no schema_version)', async () => {
      const port = new RowsDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1m');
      expect(reader).toBeDefined();
      const rows: any[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: ['BTCUSDT'] })) {
        rows.push(...batch);
      }
      expect(rows).toHaveLength(6);

      // schema_version dropped from ReaderRow
      expect(rows[0]).not.toHaveProperty('schema_version');

      // every kind copied verbatim from the source CanonicalRowV2 (not null, not recomputed)
      for (let i = 0; i < ROWS.length; i++) {
        const src = ROWS[i]!;
        expect(rows[i]).toMatchObject({
          symbol:                src.symbol,
          minute_ts:             src.minute_ts,
          open:                  src.open,
          high:                  src.high,
          low:                   src.low,
          close:                 src.close,
          volume:                src.volume,
          turnover:              src.turnover,
          oi_total_usd:          src.oi_total_usd,
          funding_rate:          src.funding_rate,
          liq_long_usd:          src.liq_long_usd,
          liq_short_usd:         src.liq_short_usd,
          has_oi:                src.has_oi,
          has_funding:           src.has_funding,
          has_liquidations:      src.has_liquidations,
          taker_buy_volume_usd:  src.taker_buy_volume_usd,
          taker_sell_volume_usd: src.taker_sell_volume_usd,
          has_taker_flow:        src.has_taker_flow,
        });
      }
    });

    it('paginates with limit=3 across multiple pages; union equals full set', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ serverPageLimit: 3 });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        const port = new RowsDataPort({ baseUrl: url, pageLimit: 3 });
        const reader = await port.openDataset('BTCUSDT:1m');
        const rows: Array<{ minute_ts: number }> = [];
        let pages = 0;
        for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: ['BTCUSDT'] })) {
          pages++;
          rows.push(...(batch as typeof rows));
        }
        expect(pages).toBeGreaterThan(1);
        expect(rows).toHaveLength(6);
        expect(rows.map(r => r.minute_ts)).toEqual(ROWS.map(r => r.minute_ts));
      } finally {
        await s?.close();
      }
    });
  });

  describe('queryOneSymbolTimeSeries()', () => {
    it('delegates to queryRange', async () => {
      const port = new RowsDataPort({ baseUrl });
      const reader = await port.openDataset('BTCUSDT:1m');
      const rangeRows: unknown[] = [];
      const tsRows: unknown[] = [];
      for await (const batch of reader!.queryRange({ tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: ['BTCUSDT'] })) rangeRows.push(...batch);
      for await (const batch of reader!.queryOneSymbolTimeSeries({ symbol: 'BTCUSDT', tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER })) tsRows.push(...batch);
      expect(tsRows).toHaveLength(rangeRows.length);
    });
  });
});
