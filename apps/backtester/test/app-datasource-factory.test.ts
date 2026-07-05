import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

function historical2Server(symbols: string[]): FastifyInstance {
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
  app.get('/historical/rows', (_r, reply) => reply.send({ items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }));
  return app;
}

describe('buildApp data-source factory', () => {
  let realSrv: FastifyInstance, mockSrv: FastifyInstance, realUrl: string, mockUrl: string;
  beforeAll(async () => {
    realSrv = historical2Server(['REALSYM']); realUrl = await realSrv.listen({ host: '127.0.0.1', port: 0 });
    mockSrv = historical2Server(['MOCKSYM']); mockUrl = await mockSrv.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await realSrv.close(); await mockSrv.close(); });

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
});
