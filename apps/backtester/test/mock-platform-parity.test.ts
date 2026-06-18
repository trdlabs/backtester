/**
 * Mock-platform data path parity gate (Feature 4).
 *
 * Proves that `MockPlatformDataPort` (BACKTESTER_DATA_SOURCE=mock) produces byte-identical
 * materialized rows compared to `FixtureDataPort` when both are fed the same underlying data.
 *
 * This test pins the invariant: the mock-platform HTTP transport is a transparent wire — it does
 * not mutate the underlying candle values (open/high/low/close/volume/turnover).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlatformDataPort } from '../src/data/mock-platform-data-port';
import { datasetFingerprint, FixtureDataPort, materialize } from '../src/data/reader';
import { FIXTURES_DIR } from './helpers';

// ── Smoke fixture rows as OHLCV bars (matches apps/backtester/fixtures/candles/smoke-btc-1m.json).
// The mock-platform server returns plain OHLCV bars (no `turnover`); MockPlatformReader computes
// turnover = close * volume.  For this fixture turnover = close * volume in every row, so the
// materialized ReaderRow[] produced via HTTP is byte-identical to the fixture path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
interface OhlcvBar { tsMs: number; open: number; high: number; low: number; close: number; volume: number; }

const SMOKE_BARS: OhlcvBar[] = [
  { tsMs: 1699999980000, open: 100, high: 101, low:  99, close: 100, volume: 10 },
  { tsMs: 1700000040000, open: 100, high: 102, low:  99, close: 101, volume: 11 },
  { tsMs: 1700000100000, open: 101, high: 103, low: 100, close: 102, volume: 12 },
  { tsMs: 1700000160000, open: 102, high: 103, low: 100, close: 101, volume: 13 },
  { tsMs: 1700000220000, open: 101, high: 104, low: 100, close: 103, volume: 14 },
  { tsMs: 1700000280000, open: 103, high: 105, low: 102, close: 104, volume: 15 },
  { tsMs: 1700000340000, open: 104, high: 105, low: 102, close: 103, volume: 16 },
  { tsMs: 1700000400000, open: 103, high: 106, low: 102, close: 105, volume: 17 },
  { tsMs: 1700000460000, open: 105, high: 107, low: 104, close: 106, volume: 18 },
  { tsMs: 1700000520000, open: 106, high: 107, low: 104, close: 105, volume: 19 },
  { tsMs: 1700000580000, open: 105, high: 108, low: 104, close: 107, volume: 20 },
  { tsMs: 1700000640000, open: 107, high: 109, low: 106, close: 108, volume: 21 },
];

const SMOKE_FROM_MS = SMOKE_BARS[0]!.tsMs;
const SMOKE_TO_MS   = SMOKE_BARS[SMOKE_BARS.length - 1]!.tsMs;
const SYMBOL        = 'BTCUSDT';
const TIMEFRAME     = '1m';

// ── Cursor encoding (matches trading-mock-platform convention) ─────────────────────────────────────
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): number {
  try { return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset: number }).offset; }
  catch { return 0; }
}
function paginate<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = cursor ? decodeCursor(cursor) : 0;
  const page   = items.slice(offset, offset + limit);
  const next   = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, nextCursor: next, asOf: Date.now(), window: {}, freshness: 'fresh' };
}

// ── Fixture server mimicking trading-mock-platform /historical/* contract ──────────────────────────
function buildSmokePlatformServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/historical/coverage', (_req, reply) => {
    return reply.send({
      entries: [{
        symbol: SYMBOL, timeframe: TIMEFRAME,
        fromMs: SMOKE_FROM_MS, toMs: SMOKE_TO_MS,
        barCount: SMOKE_BARS.length, availability: 'available',
      }],
      symbols: [SYMBOL],
      timeframes: [TIMEFRAME],
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
          name: 'bars', availability: 'available',
          supportedFilters: ['symbol', 'timeframe', 'fromMs', 'toMs'],
          pagination: { cursor: true, maxPageItems: 500 }, fields: [],
        },
        { name: 'funding',       availability: 'available', supportedFilters: [], pagination: null, fields: [] },
        { name: 'open-interest', availability: 'available', supportedFilters: [], pagination: null, fields: [] },
      ],
      symbols: [SYMBOL],
      timeframes: [TIMEFRAME],
    });
  });

  app.get('/historical/bars', (req, reply) => {
    const q = req.query as { symbol?: string; timeframe?: string; fromMs?: string; toMs?: string; cursor?: string; limit?: string };
    const fromMs  = q.fromMs ? Number(q.fromMs) : 0;
    const toMs    = q.toMs   ? Number(q.toMs)   : Infinity;
    const limit   = q.limit  ? Number(q.limit)  : 500;
    const filtered = SMOKE_BARS.filter(b => b.tsMs >= fromMs && b.tsMs <= toMs);
    return reply.send(paginate(filtered, q.cursor, limit));
  });

  app.get('/historical/funding', (_req, reply) => {
    return reply.send({ items: [], nextCursor: null, asOf: Date.now(), window: {}, freshness: 'fresh' });
  });

  app.get('/historical/open-interest', (_req, reply) => {
    return reply.send({ items: [], nextCursor: null, asOf: Date.now(), window: {}, freshness: 'fresh' });
  });

  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────────

const RANGE = { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: [SYMBOL] };

describe('mock-platform data path parity (Feature 4)', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server  = buildSmokePlatformServer();
    baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('listDatasets returns BTCUSDT:1m dataset with correct row count', async () => {
    const port = new MockPlatformDataPort({ baseUrl });
    const datasets = await port.listDatasets();
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.datasetRef).toBe(`${SYMBOL}:${TIMEFRAME}`);
    expect(datasets[0]!.rowCount).toBe(SMOKE_BARS.length);
    expect(datasets[0]!.symbols).toContain(SYMBOL);
    expect(datasets[0]!.timeframe).toBe(TIMEFRAME);
  });

  it('openDataset returns a reader for BTCUSDT:1m', async () => {
    const port = new MockPlatformDataPort({ baseUrl });
    const reader = await port.openDataset(`${SYMBOL}:${TIMEFRAME}`);
    expect(reader).toBeDefined();
  });

  it('openDataset returns undefined for unknown dataset ref', async () => {
    const port = new MockPlatformDataPort({ baseUrl });
    expect(await port.openDataset('smoke-btc-1m')).toBeUndefined();
    expect(await port.openDataset('BTCUSDT:5m')).toBeUndefined();
  });

  it('dataset_fingerprint via MockPlatformDataPort equals FixtureDataPort (candle-data parity)', async () => {
    // Mock-platform path: HTTP transport via fixture server
    const mockPort   = new MockPlatformDataPort({ baseUrl });
    const mockReader = await mockPort.openDataset(`${SYMBOL}:${TIMEFRAME}`);
    expect(mockReader).toBeDefined();
    const mockDs = await materialize(mockReader!, `${SYMBOL}:${TIMEFRAME}`, RANGE);

    // Fixture path: direct JSON reader
    const fixturePort   = new FixtureDataPort(FIXTURES_DIR);
    const fixtureReader = await fixturePort.openDataset('smoke-btc-1m');
    expect(fixtureReader).toBeDefined();
    const fixtureDs = await materialize(fixtureReader!, 'smoke-btc-1m', RANGE);

    // Structural assertions
    expect(mockDs.candles(SYMBOL)).toHaveLength(SMOKE_BARS.length);
    expect(fixtureDs.candles(SYMBOL)).toHaveLength(SMOKE_BARS.length);

    // Parity: the underlying rows must be byte-identical (turnover = close × volume in smoke fixture)
    expect(datasetFingerprint(mockDs)).toBe(datasetFingerprint(fixtureDs));
  });

  it('MockPlatformDataPort pagination: tiny page limit still returns all rows', async () => {
    const port   = new MockPlatformDataPort({ baseUrl, pageLimit: 3 });
    const reader = await port.openDataset(`${SYMBOL}:${TIMEFRAME}`);
    let count = 0;
    let pages = 0;
    for await (const batch of reader!.queryRange(RANGE)) {
      pages += 1;
      count += batch.length;
    }
    expect(count).toBe(SMOKE_BARS.length);
    expect(pages).toBeGreaterThan(1);
  });
});
