import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RunResultSummary } from '@trading/research-contracts';
import { createDataApiServer } from '../src/data/data-api-server';
import { HttpDataPort } from '../src/data/http-data-port';
import { datasetFingerprint, FixtureDataPort, materialize } from '../src/data/reader';
import { AUTH, buildTestApp, FIXTURES_DIR, runBody, testDeps } from './helpers';

// Same inputs/runId as the determinism golden — proves the HTTP transport doesn't change the result.
const GOLDEN_RESULT_HASH = 'sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba';
const RANGE = { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: ['BTCUSDT'] };

describe('research historical data API (HTTP platformDataClient)', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = createDataApiServer(new FixtureDataPort(FIXTURES_DIR));
    baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await server.close();
  });

  it('lists datasets over HTTP', async () => {
    const port = new HttpDataPort({ baseUrl });
    const datasets = await port.listDatasets();
    expect(datasets.find((d) => d.datasetRef === 'smoke-btc-1m')).toBeDefined();
  });

  it('unknown dataset → openDataset returns undefined', async () => {
    const port = new HttpDataPort({ baseUrl });
    expect(await port.openDataset('nope')).toBeUndefined();
  });

  it('materialized tape + dataset_fingerprint match the in-process reader (transport parity)', async () => {
    const fixtureReader = await new FixtureDataPort(FIXTURES_DIR).openDataset('smoke-btc-1m');
    const fixtureDs = await materialize(fixtureReader!, 'smoke-btc-1m', RANGE);

    const httpReader = await new HttpDataPort({ baseUrl, pageLimit: 3 }).openDataset('smoke-btc-1m');
    const httpDs = await materialize(httpReader!, 'smoke-btc-1m', RANGE);

    expect(httpDs.candles('BTCUSDT').length).toBe(fixtureDs.candles('BTCUSDT').length);
    expect(datasetFingerprint(httpDs)).toBe(datasetFingerprint(fixtureDs));
  });

  it('paging returns every row with a tiny page limit (streaming, multi-page)', async () => {
    const reader = await new HttpDataPort({ baseUrl, pageLimit: 2 }).openDataset('smoke-btc-1m');
    let count = 0;
    let pages = 0;
    for await (const batch of reader!.queryRange(RANGE)) {
      pages += 1;
      count += batch.length;
    }
    expect(count).toBe(12); // the smoke fixture has 12 rows
    expect(pages).toBeGreaterThan(1); // proves the cursor walked multiple pages
  });

  it('end-to-end run over the HTTP data port yields the unchanged golden result_hash', async () => {
    const app = await buildTestApp({}, testDeps({ dataPort: new HttpDataPort({ baseUrl, pageLimit: 4 }) }));
    try {
      await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'det-run' }),
      });
      expect(await app.drain()).toBe(1);
      const result = (
        await app.server.inject({ url: '/v1/runs/det-run/result', headers: AUTH })
      ).json() as RunResultSummary;
      expect(result.status).toBe('completed');
      expect(result.resultHash).toBe(GOLDEN_RESULT_HASH);
      expect(result.evidence.datasetFingerprint).toMatch(/^sha256:/);
    } finally {
      await app.dispose();
    }
  });

  it('enforces a bearer token when the data API requires one', async () => {
    const secured = createDataApiServer(new FixtureDataPort(FIXTURES_DIR), { authToken: 'data-secret' });
    const url = await secured.listen({ host: '127.0.0.1', port: 0 });
    try {
      await expect(new HttpDataPort({ baseUrl: url }).listDatasets()).rejects.toThrow();
      const ok = await new HttpDataPort({ baseUrl: url, token: 'data-secret' }).listDatasets();
      expect(ok.length).toBeGreaterThan(0);
    } finally {
      await secured.close();
    }
  });
});

// Optional integration against a REAL external platform/mock data API. Skips (does not fail) unless
// BACKTESTER_TEST_DATA_API_URL is set and reachable — mirrors the pg/Docker gating.
const EXT_URL = process.env.BACKTESTER_TEST_DATA_API_URL;
async function externalReachable(): Promise<boolean> {
  if (!EXT_URL) return false;
  try {
    const res = await fetch(`${EXT_URL.replace(/\/+$/, '')}/data/v1/datasets`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const EXT_AVAILABLE = await externalReachable();

describe.skipIf(!EXT_AVAILABLE)('external platform/mock data API integration', () => {
  it('lists datasets from the configured external data API', async () => {
    const port = new HttpDataPort({
      baseUrl: EXT_URL as string,
      ...(process.env.BACKTESTER_TEST_DATA_API_TOKEN
        ? { token: process.env.BACKTESTER_TEST_DATA_API_TOKEN }
        : {}),
    });
    expect(Array.isArray(await port.listDatasets())).toBe(true);
  });
});
