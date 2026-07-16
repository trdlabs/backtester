import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { FixtureDataPort } from '../src/data/reader';
import { testConfig, FIXTURES_DIR } from './helpers';

function historical2Server(
  symbols: string[],
  rows: readonly unknown[] = [],
  authorizations: string[] = [],
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/historical/discover', (_r, reply) => reply.send({
    historicalContractVersion: 'historical.2',
    capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
    resources: [{ name: 'rows', availability: 'available', supportedFilters: ['symbols','fromMs','toMs'], pagination: { cursor: true, maxPageItems: 100 }, fields: [] }],
    symbols, timeframes: ['1m'],
  }));
  // NB: listDatasets() filters `availability==='available' && barCount>0`, so coverage MUST report a
  // non-empty dataset or the assertion is a false red (empty regardless of the real-branch fix).
  app.get('/historical/coverage', (_r, reply) => reply.send({ entries: symbols.map(s => ({ symbol: s, timeframe: '1m', fromMs: 0, toMs: 300_000, barCount: 6, availability: 'available' })), symbols, timeframes: ['1m'], availability: 'available', asOf: 0 }));
  app.get('/historical/rows', (request, reply) => {
    const authorization = request.headers.authorization;
    if (authorization) authorizations.push(authorization);
    return reply.send({ items: rows, nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' });
  });
  return app;
}

const CANONICAL_ROW = { schema_version: 2, symbol: 'REALSYM', minute_ts: 60_000 };

async function collectRows(app: Awaited<ReturnType<typeof buildApp>>, datasetRef: string) {
  const reader = await app.dataPort.openDataset(datasetRef);
  if (!reader) throw new Error(`missing reader for ${datasetRef}`);
  const rows: unknown[] = [];
  for await (const page of reader.queryRange({ tsFrom: 0, tsTo: 120_000, symbols: [datasetRef.split(':')[0]!] })) {
    rows.push(...page);
  }
  return rows;
}

describe('buildApp data-source factory', () => {
  let realSrv: FastifyInstance, mockSrv: FastifyInstance, realUrl: string, mockUrl: string;
  let sharedRealSrv: FastifyInstance, sharedMockSrv: FastifyInstance, sharedRealUrl: string, sharedMockUrl: string;
  let realAuthorizations: string[], mockAuthorizations: string[];
  let sharedRealAuthorizations: string[], sharedMockAuthorizations: string[];
  beforeAll(async () => {
    realAuthorizations = [];
    mockAuthorizations = [];
    realSrv = historical2Server(['REALSYM'], [CANONICAL_ROW, { ...CANONICAL_ROW, minute_ts: 120_000 }], realAuthorizations);
    realUrl = await realSrv.listen({ host: '127.0.0.1', port: 0 });
    mockSrv = historical2Server(['MOCKSYM'], [{ ...CANONICAL_ROW, symbol: 'MOCKSYM' }, { ...CANONICAL_ROW, symbol: 'MOCKSYM', minute_ts: 120_000 }], mockAuthorizations);
    mockUrl = await mockSrv.listen({ host: '127.0.0.1', port: 0 });
    sharedRealAuthorizations = [];
    sharedMockAuthorizations = [];
    const sharedRows = [{ ...CANONICAL_ROW, symbol: 'BTCUSDT' }, { ...CANONICAL_ROW, symbol: 'BTCUSDT', minute_ts: 120_000 }];
    sharedRealSrv = historical2Server(['BTCUSDT'], sharedRows, sharedRealAuthorizations);
    sharedRealUrl = await sharedRealSrv.listen({ host: '127.0.0.1', port: 0 });
    sharedMockSrv = historical2Server(['BTCUSDT'], sharedRows, sharedMockAuthorizations);
    sharedMockUrl = await sharedMockSrv.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await realSrv.close();
    await mockSrv.close();
    await sharedRealSrv.close();
    await sharedMockSrv.close();
  });

  it("dataSource=real opens datasets from the REAL pair, not the mock pair", async () => {
    const cfg = loadConfig({
      BACKTESTER_DATA_SOURCE: 'real',
      BACKTESTER_REAL_PLATFORM_URL: realUrl, BACKTESTER_REAL_PLATFORM_TOKEN: 'real-tok',
      BACKTESTER_MOCK_PLATFORM_URL: mockUrl, BACKTESTER_MOCK_PLATFORM_TOKEN: 'mock-tok',
    });
    const app = await buildApp(cfg);
    const datasets = await app.dataPort.listDatasets();
    expect(datasets.map(d => d.datasetRef)).toContain('REALSYM:1m');
    expect(datasets.map(d => d.datasetRef)).not.toContain('MOCKSYM:1m');
    await app.dispose();
  });

  it('rejects dataSource=real with no realPlatformUrl instead of silently falling back to FixtureDataPort', async () => {
    // Bypasses loadConfig's own fail-fast validation by constructing the AppConfig literal directly
    // (as a caller assembling config from another source might) — buildApp itself must guard this.
    const cfg = testConfig({ dataSource: 'real' });
    await expect(buildApp(cfg)).rejects.toThrow(
      /BACKTESTER_DATA_SOURCE=real requires a real platform URL/,
    );
  });

  it('does NOT throw when a dataPort override is supplied, even with dataSource=real and no realPlatformUrl', async () => {
    // The guard exists to prevent a SILENT fixture fallback. When the caller injects a dataPort
    // directly, the factory ternary never runs and config.realPlatformUrl is irrelevant — the
    // guard must not fire.
    const cfg = testConfig({ dataSource: 'real' });
    const app = await buildApp(cfg, { dataPort: new FixtureDataPort(FIXTURES_DIR) });
    expect(app.dataPort).toBeInstanceOf(FixtureDataPort);
    await app.dispose();
  });

  it.each([
    ['real', 'REALSYM:1m', 'real-tok'],
    ['mock', 'MOCKSYM:1m', 'mock-tok'],
  ] as const)('%s selects its own endpoint and token to read rows', async (dataSource, datasetRef, token) => {
    const app = await buildApp(
      testConfig({
        dataSource,
        realPlatformUrl: realUrl,
        realPlatformToken: 'real-tok',
        mockPlatformUrl: mockUrl,
        mockPlatformToken: 'mock-tok',
      }),
    );
    try {
      await expect(collectRows(app, datasetRef)).resolves.toHaveLength(2);
      const calls = dataSource === 'real' ? realAuthorizations : mockAuthorizations;
      expect(calls).toContain(`Bearer ${token}`);
    } finally {
      await app.dispose();
    }
  });

  it('real and mock production sources read identical canonical rows with their own credentials', async () => {
    const baseConfig = {
      realPlatformUrl: sharedRealUrl,
      realPlatformToken: 'shared-real-tok',
      mockPlatformUrl: sharedMockUrl,
      mockPlatformToken: 'shared-mock-tok',
    };
    const realApp = await buildApp(testConfig({ ...baseConfig, dataSource: 'real' }));
    const mockApp = await buildApp(testConfig({ ...baseConfig, dataSource: 'mock' }));
    try {
      const [realRows, mockRows] = await Promise.all([
        collectRows(realApp, 'BTCUSDT:1m'),
        collectRows(mockApp, 'BTCUSDT:1m'),
      ]);
      expect(realRows).toEqual(mockRows);
      expect(realRows).toEqual([
        { symbol: 'BTCUSDT', minute_ts: 60_000 },
        { symbol: 'BTCUSDT', minute_ts: 120_000 },
      ]);
      expect(sharedRealAuthorizations).toContain('Bearer shared-real-tok');
      expect(sharedMockAuthorizations).toContain('Bearer shared-mock-tok');
    } finally {
      await realApp.dispose();
      await mockApp.dispose();
    }
  });

  it.each([
    ['real', 'REALSYM:1m'],
    ['mock', 'MOCKSYM:1m'],
  ] as const)('%s forwards dataApiMaxRows to RowsDataPort', async (dataSource, datasetRef) => {
    const app = await buildApp(
      testConfig({
        dataSource,
        realPlatformUrl: realUrl,
        realPlatformToken: 'real-tok',
        mockPlatformUrl: mockUrl,
        mockPlatformToken: 'mock-tok',
        dataApiMaxRows: 1,
      }),
    );
    try {
      await expect(collectRows(app, datasetRef)).rejects.toThrow(/exceeded maxRows 1/);
    } finally {
      await app.dispose();
    }
  });
});
