/**
 * Rows-path byte-identity gate (Initiative #1, Phase C — self-contained CI coverage).
 *
 * Proves that `RowsDataPort`, reading a historical.2 `/historical/rows` server over the VENDORED
 * platform golden, produces `ReaderRow[]` byte-identical to that golden (minus `schema_version`).
 *
 * This is the consumer-side `real == mock` byte-identity assertion, made self-contained: the fake
 * server replays the vendored `platform-golden/MANIFEST.json` (30 CanonicalRowV2 rows, all kinds
 * populated incl. liquidations/taker-flow/turnover/oi/funding), so no platform repo is required.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RowsDataPort } from '../src/data/rows-data-port';
import type { ReaderRow } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(HERE, 'fixtures/platform-golden/MANIFEST.json');

/** CanonicalRowV2 = ReaderRow + schema_version (the wire shape the platform emits). */
interface CanonicalRowV2 extends ReaderRow {
  readonly schema_version: number;
}

const GOLDEN: CanonicalRowV2[] = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as CanonicalRowV2[];

const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '1m';
const FROM_MS = GOLDEN[0]!.minute_ts;
const TO_MS = GOLDEN[GOLDEN.length - 1]!.minute_ts;

/** Expected ReaderRow[] = golden rows with `schema_version` dropped (RowsReader strips it). */
const EXPECTED_ROWS: ReaderRow[] = GOLDEN.map(({ schema_version: _sv, ...rest }) => rest);

// ── base64url cursor pagination (matches RowsReader / platform convention) ──
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

// ── Fake historical.2 server replaying the vendored golden ──
function buildHistorical2Server(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/historical/discover', (_req, reply) =>
    reply.send({
      historicalContractVersion: 'historical.2',
      capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
      resources: [
        {
          name: 'rows',
          availability: 'available',
          supportedFilters: ['symbols', 'fromMs', 'toMs'],
          pagination: { cursor: true, maxPageItems: 1000 },
          fields: [],
        },
      ],
      symbols: [SYMBOL],
      timeframes: [TIMEFRAME],
    }),
  );

  app.get('/historical/coverage', (_req, reply) =>
    reply.send({
      entries: [
        {
          symbol: SYMBOL,
          timeframe: TIMEFRAME,
          fromMs: FROM_MS,
          toMs: TO_MS,
          barCount: GOLDEN.length,
          availability: 'available',
        },
      ],
      symbols: [SYMBOL],
      timeframes: [TIMEFRAME],
      availability: 'available',
      asOf: Date.now(),
    }),
  );

  app.get('/historical/rows', (req, reply) => {
    const q = req.query as {
      symbols?: string;
      fromMs?: string;
      toMs?: string;
      cursor?: string;
      limit?: string;
    };
    const fromMs = q.fromMs ? Number(q.fromMs) : 0;
    const toMs = q.toMs ? Number(q.toMs) : Infinity;
    const limit = q.limit ? Number(q.limit) : 1000;
    const filtered = GOLDEN.filter((r) => r.minute_ts >= fromMs && r.minute_ts <= toMs);
    const offset = q.cursor ? decodeCursor(q.cursor) : 0;
    const items = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
    return reply.send({ items, nextCursor });
  });

  return app;
}

const RANGE = { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: [SYMBOL] };

async function collectRows(port: RowsDataPort): Promise<ReaderRow[]> {
  const reader = await port.openDataset(`${SYMBOL}:${TIMEFRAME}`);
  expect(reader).toBeDefined();
  const out: ReaderRow[] = [];
  for await (const batch of reader!.queryRange(RANGE)) out.push(...batch);
  return out;
}

describe('rows-path byte-identity vs vendored platform golden (self-contained)', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = buildHistorical2Server();
    baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('vendored golden sanity: 30 rows, BTCUSDT, full canonical surface with both present & absent kinds', () => {
    expect(GOLDEN).toHaveLength(30);
    expect(new Set(GOLDEN.map((r) => r.symbol))).toEqual(new Set([SYMBOL]));
    // Every row carries every canonical column (present-zero vs absent encoded via has_* flags).
    for (const r of GOLDEN) {
      for (const k of [
        'open', 'high', 'low', 'close', 'volume', 'turnover', 'oi_total_usd', 'funding_rate',
        'liq_long_usd', 'liq_short_usd', 'has_oi', 'has_funding', 'has_liquidations',
        'taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow',
      ] as const) {
        expect(r).toHaveProperty(k);
      }
    }
    // The golden exercises BOTH present and absent variants of the enriched kinds — so byte-identity
    // proves the rows-path preserves the presence-flag distinction, not just non-null values.
    const liqFlags = new Set(GOLDEN.map((r) => r.has_liquidations));
    const takerFlags = new Set(GOLDEN.map((r) => r.has_taker_flow));
    expect(liqFlags).toEqual(new Set([true, false]));
    expect(takerFlags).toEqual(new Set([true, false]));
    expect(GOLDEN.every((r) => r.has_oi && r.has_funding)).toBe(true);
  });

  it('openDataset → ReaderRow[] equals golden byte-for-byte (minus schema_version), full row incl liq/taker/turnover', async () => {
    const rows = await collectRows(new RowsDataPort({ baseUrl }));

    expect(rows).toHaveLength(30);
    // Whole-array deep equality is the byte-identity assertion: every field of every row matches.
    expect(rows).toEqual(EXPECTED_ROWS);

    // Spot-pin the enriched kinds explicitly so a regression names the offending column.
    for (let i = 0; i < rows.length; i += 1) {
      const got = rows[i]!;
      const want = EXPECTED_ROWS[i]!;
      expect(got.liq_long_usd).toBe(want.liq_long_usd);
      expect(got.liq_short_usd).toBe(want.liq_short_usd);
      expect(got.has_liquidations).toBe(want.has_liquidations);
      expect(got.taker_buy_volume_usd).toBe(want.taker_buy_volume_usd);
      expect(got.taker_sell_volume_usd).toBe(want.taker_sell_volume_usd);
      expect(got.has_taker_flow).toBe(want.has_taker_flow);
      expect(got.turnover).toBe(want.turnover);
      expect(got.oi_total_usd).toBe(want.oi_total_usd);
      expect(got.funding_rate).toBe(want.funding_rate);
    }

    // schema_version must NOT leak into ReaderRow.
    for (const r of rows) {
      expect(r as unknown as Record<string, unknown>).not.toHaveProperty('schema_version');
    }
  });

  it('pagination: tiny page limit unions back to the full 30-row golden', async () => {
    const rows = await collectRows(new RowsDataPort({ baseUrl, pageLimit: 3 }));
    expect(rows).toHaveLength(30);
    expect(rows).toEqual(EXPECTED_ROWS);
  });
});
