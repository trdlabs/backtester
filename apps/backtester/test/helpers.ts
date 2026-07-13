import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppHandles, type BuildAppOptions } from '../src/app';
import type { SigningKey } from '../src/evidence/signing.js';
import { InMemoryArtifactStore } from '../src/artifacts/store';
import type { AppConfig } from '../src/config';
import { DEFAULT_SANDBOX, SANDBOX_IMAGE } from '../src/engine/sandbox-policy';
import type { JobStore } from '../src/jobs/job-store';
import type { RunSubmitRequest } from '@trading/research-contracts';
import type { StoreFactory } from './store-factories';
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';

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
    storeBackend: 'filesystem',
    dataSource: 'fixture',
    dataApiPageLimit: 1000,
    pgPoolMax: 10,
    pgStatementTimeoutMs: 0,
    defaultQueueTimeoutMs: 3_600_000,
    defaultRunTimeoutMs: 3_600_000,
    autoWorker: false,
    workerConcurrency: 1,
    workerId: 'test-worker',
    workerLeaseTtlMs: 30_000,
    workerHeartbeatMs: 10_000,
    workerMaxAttempts: 3,
    workerPollMs: 500,
    enableOverlayEngine: false,
    dedupEnabled: false,
    jobObs: false,
    coalesceEnabled: false,
    barBatching: false,
    barMajor: false,
    barMajorBatch: false,
    trialLedger: false,
    trialEmpiricalMinN: 5,
    holdout: false,
    holdoutFraction: 0.2,
    runDiagnostics: false,
    diagMinTrades: 30,
    diagConcentrationPct: 80,
    novelty: false,
    noveltyCorrThreshold: 0.8,
    noveltyMinOverlapDays: 30,
    batchBars: 64,
    universeSession: false,
    universeMaxN: 64,
    universeMemBaseMb: 128,
    universeMemPerSymbolMb: 8,
    queueNotify: false,
    computeLockTtlMs: 30_000,
    computeWaitMaxAttempts: 3,
    queueMaxDepth: 0,
    queueRetryAfterS: 30,
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
    overlaySandbox: {
      harnessDir: resolve(HERE, '../sandbox-harness-overlay'),
      image: SANDBOX_IMAGE,
      policy: {
        ...DEFAULT_SANDBOX,
        isolation: { ...DEFAULT_SANDBOX.isolation, image: SANDBOX_IMAGE },
        limits: { ...DEFAULT_SANDBOX.limits },
      },
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
  over: Partial<AppConfig> & { evidenceSigningKey?: SigningKey } = {},
  deps?: BuildAppOptions,
): Promise<AppHandles> {
  const { evidenceSigningKey, ...configOver } = over;
  const resolvedDeps = deps ?? testDeps(evidenceSigningKey ? { evidenceSigningKey } : {});
  return buildApp(testConfig(configOver), resolvedDeps);
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

/** Shared fixture ModuleBundle for tests that need a bundle by value or by hash. */
export function makeBundle(): ModuleBundle {
  const manifest = createModuleManifest({
    id: 'b',
    version: '1.0.0',
    kind: 'strategy',
    name: 'fixture',
    summary: 's',
    rationale: 'r',
    hooks: ['onBarClose'],
    paramsSchema: { type: 'object' },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
  });
  return { manifest, entry: 'module.mjs', files: { 'module.mjs': 'export function signals(c){return c.map(()=>false);}' } };
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
