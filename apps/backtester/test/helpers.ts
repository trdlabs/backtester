import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppHandles, type BuildAppOptions } from '../src/app';
import { InMemoryArtifactStore } from '../src/artifacts/store';
import type { AppConfig } from '../src/config';
import type { JobStore } from '../src/jobs/job-store';
import type { RunSubmitRequest } from '@trading/research-contracts';
import type { StoreFactory } from './store-factories';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');
export const HARNESS_DIR = resolve(HERE, '../sandbox-harness');
export const AUTH = { authorization: 'Bearer test-token' };

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    authToken: 'test-token',
    fixturesDir: FIXTURES_DIR,
    artifactsDir: mkdtempSync(resolve(tmpdir(), 'bt-artifacts-')),
    bundlesDir: mkdtempSync(resolve(tmpdir(), 'bt-bundles-')),
    dataSource: 'fixture',
    dataApiPageLimit: 1000,
    defaultQueueTimeoutMs: 3_600_000,
    defaultRunTimeoutMs: 3_600_000,
    autoWorker: false,
    enableOverlayEngine: false,
    sandbox: {
      harnessDir: HARNESS_DIR,
      image: 'node:24-alpine',
      memoryMb: 256,
      cpus: 1,
      pidsLimit: 64,
      wallTimeMs: 5_000,
      tmpfsMb: 64,
      user: '65534:65534',
    },
    ...over,
  };
}

/** Fixed clock (deterministic deadlines) + random ids + in-memory artifact store. */
export function testDeps(extra: Partial<BuildAppOptions> = {}): BuildAppOptions {
  return {
    artifactStore: new InMemoryArtifactStore(),
    clock: () => 1_700_000_000_000,
    uid: () => randomUUID(),
    ...extra,
  };
}

export async function buildTestApp(
  over: Partial<AppConfig> = {},
  deps: BuildAppOptions = testDeps(),
): Promise<AppHandles> {
  return buildApp(testConfig(over), deps);
}

/** Build an app over a factory's store, returning a combined cleanup (dispose app + teardown store). */
export async function makeApp(
  factory: StoreFactory,
  extra: Partial<BuildAppOptions> = {},
  over: Partial<AppConfig> = {},
): Promise<{ app: AppHandles; store: JobStore; cleanup: () => Promise<void> }> {
  const handle = await factory.create();
  const app = await buildTestApp(over, testDeps({ store: handle.store, ...extra }));
  return {
    app,
    store: handle.store,
    cleanup: async () => {
      await app.dispose();
      await handle.teardown();
    },
  };
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
