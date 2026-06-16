import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppHandles, type BuildAppOptions } from '../src/app';
import { InMemoryArtifactStore } from '../src/artifacts/store';
import type { AppConfig } from '../src/config';
import type { RunSubmitRequest } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');
export const AUTH = { authorization: 'Bearer test-token' };

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    authToken: 'test-token',
    fixturesDir: FIXTURES_DIR,
    artifactsDir: mkdtempSync(resolve(tmpdir(), 'bt-artifacts-')),
    defaultQueueTimeoutMs: 3_600_000,
    defaultRunTimeoutMs: 3_600_000,
    autoWorker: false,
    ...over,
  };
}

/** Deterministic clock + sequential ids + in-memory artifact store, for golden assertions. */
export function fixedDeps(): BuildAppOptions {
  let seq = 0;
  return {
    artifactStore: new InMemoryArtifactStore(),
    clock: () => 1_700_000_000_000,
    uid: () => `id-${(seq += 1)}`,
  };
}

export function buildTestApp(
  over: Partial<AppConfig> = {},
  deps: BuildAppOptions = fixedDeps(),
): AppHandles {
  return buildApp(testConfig(over), deps);
}

export function runBody(over: Partial<RunSubmitRequest> = {}): RunSubmitRequest {
  return {
    mode: 'research',
    moduleRef: { id: 'smoke', version: '1.0.0' },
    datasetRef: 'smoke-btc-1m',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
    seed: 42,
    metrics: [],
    ...over,
  };
}
