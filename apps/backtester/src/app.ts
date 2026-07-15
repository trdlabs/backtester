// Composition root. Selects PgJobStore when a database URL is configured (Slice 2), else in-memory.
// Tests inject a store (and a fake webhook poster) via overrides and drive drain/reap/outbox manually.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from './api/server';
import type { AppConfig } from './config';
import type { ArtifactStore } from './artifacts/store';
import { FixtureDataPort, type BacktesterDataPort } from './data/reader';
import { HttpDataPort } from './data/http-data-port';
import { RowsDataPort } from './data/rows-data-port';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import {
  defaultWebhookPoster,
  deliverOutbox,
  publishCompletion,
  reapAndPublish,
  type CompletionDeps,
  type WebhookPoster,
} from './jobs/completion';
import { InMemoryJobStore, type JobStore } from './jobs/job-store';
import { PgJobStore } from './jobs/pg-job-store';
import { drainQueue, type WorkerDeps } from './jobs/worker';
import { InMemoryResultCache } from './jobs/dedup/result-cache';
import { PgResultCache } from './jobs/dedup/pg-result-cache';
import { InMemoryTrialLedger } from './jobs/ledger/trial-ledger';
import { PgTrialLedger } from './jobs/ledger/pg-trial-ledger';
import { InMemoryNoveltyPool } from './jobs/ledger/novelty-pool';
import { PgNoveltyPool } from './jobs/ledger/pg-novelty-pool';
import { InMemoryComputeLockStore } from './jobs/coalesce/compute-lock.js';
import { PgComputeLockStore } from './jobs/coalesce/pg-compute-lock.js';
import { InMemoryPromotionAttemptLedger } from './jobs/promotion/attempt-ledger.js';
import { PgPromotionAttemptLedger } from './jobs/promotion/pg-attempt-ledger.js';
import { DatasetIdentityEpochResolver } from './jobs/promotion/epoch-resolver.js';
import { buildPromotionPolicy } from './jobs/promotion/resolve-promotion.js';
import { wakeComputeWaiters } from './jobs/coalesce/wake.js';
import { createCoalesceMaintenance, createResultCacheSweep } from './jobs/coalesce/maintenance.js';
import { ObsRegistry } from './jobs/obs-registry.js';
import { loadSigningKeyFromPem, type SigningKey } from './evidence/signing.js';
import type { BundleStore } from './sandbox/bundle-store';
import type { SandboxConfig } from './sandbox/sandbox-executor';
import { createArtifactStore, createBundleStore } from './storage/stores';
import { createS3ObjectClient } from './storage/s3-client';

export interface BuildAppOptions {
  store?: JobStore;
  dataPort?: BacktesterDataPort;
  artifactStore?: ArtifactStore;
  bundleStore?: BundleStore;
  sandbox?: SandboxConfig;
  clock?: () => number;
  uid?: () => string;
  postWebhook?: WebhookPoster;
  /** Directly inject an already-constructed SigningKey (for tests). Takes precedence over config.evidenceSigningKeyPem. */
  evidenceSigningKey?: SigningKey;
}

export interface AppHandles {
  server: FastifyInstance;
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  workerDeps: WorkerDeps;
  drain: () => Promise<number>;
  reap: () => Promise<unknown>;
  deliverOutbox: () => Promise<number>;
  /** Run one worker pass (drain + reap + outbox + coalescing maintenance). Exposed for deterministic tests. */
  tick: () => Promise<void>;
  startWorker: () => void;
  stopWorker: () => void;
  dispose: () => Promise<void>;
}

export async function buildApp(config: AppConfig, overrides: BuildAppOptions = {}): Promise<AppHandles> {
  if (!overrides.dataPort && config.dataSource === 'real' && !config.realPlatformUrl) {
    throw new Error(
      'BACKTESTER_DATA_SOURCE=real requires a real platform URL (bypassed loadConfig validation?)',
    );
  }

  let ownedPool: Pool | undefined;
  let store = overrides.store;
  if (!store) {
    if (config.databaseUrl) {
      // Migrations run on a dedicated no-opts pool: DDL must never inherit statement_timeout.
      const migrationPool = createPool(config.databaseUrl);
      try {
        await migrate(migrationPool);
      } finally {
        await migrationPool.end();
      }
      ownedPool = createPool(config.databaseUrl, undefined, {
        max: config.pgPoolMax,
        statementTimeoutMs: config.pgStatementTimeoutMs,
      });
      store = new PgJobStore(ownedPool);
    } else {
      store = new InMemoryJobStore();
    }
  }
  const resultCache = ownedPool ? new PgResultCache(ownedPool) : new InMemoryResultCache();
  // E2: construct the trial ledger only when enabled — flag-OFF stays fully inert (no Pg table dep).
  const trialLedger = config.trialLedger
    ? ownedPool
      ? new PgTrialLedger(ownedPool)
      : new InMemoryTrialLedger()
    : undefined;
  const computeLock = config.coalesceEnabled
    ? (ownedPool ? new PgComputeLockStore(ownedPool) : new InMemoryComputeLockStore())
    : undefined;
  // E5a: construct the novelty pool only when enabled — flag-OFF stays fully inert (no Pg table dep).
  const noveltyPool = config.novelty
    ? ownedPool
      ? new PgNoveltyPool(ownedPool)
      : new InMemoryNoveltyPool()
    : undefined;
  // E4b: construct the promotion attempt ledger only when enabled — flag-OFF stays fully inert.
  const promotionLedger = config.promotionHoldoutGate
    ? (ownedPool ? new PgPromotionAttemptLedger(ownedPool) : new InMemoryPromotionAttemptLedger())
    : undefined;

  const dataPort =
    overrides.dataPort ??
    (config.dataSource === 'http' && config.dataApiUrl
      ? new HttpDataPort({
          baseUrl: config.dataApiUrl,
          ...(config.dataApiToken ? { token: config.dataApiToken } : {}),
          pageLimit: config.dataApiPageLimit,
          timeoutMs: config.dataApiTimeoutMs,
          maxAttempts: config.dataApiMaxAttempts,
          retryBaseMs: config.dataApiRetryBaseMs,
          retryMaxMs: config.dataApiRetryMaxMs,
          maxPages: config.dataApiMaxPages,
          maxRows: config.dataApiMaxRows,
          operationDeadlineMs: config.dataApiOperationDeadlineMs,
        })
      : config.dataSource === 'real' && config.realPlatformUrl
      ? new RowsDataPort({
          baseUrl:   config.realPlatformUrl,
          pageLimit: config.dataApiPageLimit,
          ...(config.realPlatformToken ? { token: config.realPlatformToken } : {}),
        })
      : config.dataSource === 'mock' && config.mockPlatformUrl
      ? new RowsDataPort({
          baseUrl:   config.mockPlatformUrl,
          pageLimit: config.dataApiPageLimit,
          ...(config.mockPlatformToken ? { token: config.mockPlatformToken } : {}),
        })
      : new FixtureDataPort(config.fixturesDir));
  // Build one shared S3 client when the S3 backend is active and at least one store isn't overridden,
  // so the artifact and bundle stores share a single connection pool instead of constructing two.
  const sharedS3Client =
    config.storeBackend === 's3' && config.s3 && (!overrides.artifactStore || !overrides.bundleStore)
      ? await createS3ObjectClient(config.s3)
      : undefined;
  const artifactStore = overrides.artifactStore ?? (await createArtifactStore(config, sharedS3Client));
  const bundleStore = overrides.bundleStore ?? (await createBundleStore(config, sharedS3Client));
  const clock = overrides.clock ?? ((): number => Date.now());
  const uid = overrides.uid ?? ((): string => randomUUID());
  const postWebhook = overrides.postWebhook ?? defaultWebhookPoster();
  const obs = config.jobObs ? new ObsRegistry(clock()) : undefined;

  const sandbox: SandboxConfig = overrides.sandbox ?? {
    harnessDir: config.sandbox.harnessDir,
    limits: {
      image: config.sandbox.image,
      memoryMb: config.sandbox.memoryMb,
      cpus: config.sandbox.cpus,
      pidsLimit: config.sandbox.pidsLimit,
      wallTimeMs: config.sandbox.wallTimeMs,
      tmpfsMb: config.sandbox.tmpfsMb,
      user: config.sandbox.user,
      maxOutputBytes: 4_000_000,
    },
  };

  const completionDeps: CompletionDeps = { store, clock, uid, postWebhook };
  const workerDeps: WorkerDeps = {
    ...completionDeps,
    dataPort,
    artifactStore,
    bundleStore,
    sandbox,
    overlaySandbox: config.overlaySandbox,
    resultCache,
    dedupEnabled: config.dedupEnabled,
    ...(computeLock ? { computeLock } : {}),
    coalesceEnabled: config.coalesceEnabled,
    barBatching: config.barBatching,
    barMajor: config.barMajor,
    barMajorBatch: config.barMajorBatch,
    batchBars: config.batchBars,
    ...(config.universeSession
      ? {
          universe: {
            enabled: true,
            maxN: config.universeMaxN,
            memBaseMb: config.universeMemBaseMb,
            memPerSymbolMb: config.universeMemPerSymbolMb,
          },
        }
      : {}),
    computeLockTtlMs: config.computeLockTtlMs,
    ...(config.resultCacheTtlMs !== undefined ? { resultCacheTtlMs: config.resultCacheTtlMs } : {}),
    ...(config.resultCacheSweepIntervalMs !== undefined ? { resultCacheSweepIntervalMs: config.resultCacheSweepIntervalMs } : {}),
    computeWaitMaxAttempts: config.computeWaitMaxAttempts,
    ...(obs ? { obs } : {}),
    ...(trialLedger
      ? { trialLedger, trialLedgerEnabled: true, trialEmpiricalMinN: config.trialEmpiricalMinN }
      : {}),
    ...(config.holdout ? { holdout: { enabled: true, fraction: config.holdoutFraction } } : {}),
    ...(config.runDiagnostics
      ? { diagnostics: { enabled: true, minTrades: config.diagMinTrades, concentrationPct: config.diagConcentrationPct } }
      : {}),
    ...(noveltyPool
      ? { novelty: { enabled: true, threshold: config.noveltyCorrThreshold, minOverlapDays: config.noveltyMinOverlapDays, pool: noveltyPool } }
      : {}),
    ...(config.walkForward ? { walkForward: { enabled: true, maxFolds: config.walkForwardMaxFolds } } : {}),
    ...(config.promotionHoldoutGate && promotionLedger
      ? { promotion: { enabled: true, ledger: promotionLedger,
          epochResolver: new DatasetIdentityEpochResolver(dataPort),
          policy: buildPromotionPolicy({ holdoutFraction: config.holdoutFraction }) } }
      : {}),
    ...(overrides.evidenceSigningKey
      ? { evidenceSigningKey: overrides.evidenceSigningKey }
      : config.evidenceSigningKeyPem
      ? { evidenceSigningKey: loadSigningKeyFromPem(config.evidenceSigningKeyPem) }
      : {}),
  };

  const drain = (): Promise<number> => drainQueue(workerDeps, config.workerConcurrency);
  const reap = (): Promise<unknown> =>
    reapAndPublish(completionDeps, {
      coalesceEnabled: config.coalesceEnabled,
      computeWaitMaxAttempts: config.computeWaitMaxAttempts,
    });
  const flushOutbox = (): Promise<number> => deliverOutbox(completionDeps);

  // P3-6a: shared coalescing maintenance (wake followers + throttled orphan-lock sweep) — the SAME
  // step the multi-process runWorkerLoop uses, so orphan compute-locks are cleaned in the single-process
  // autoWorker too (tick() previously woke followers but never swept).
  const coalesceMaintain =
    config.coalesceEnabled && computeLock
      ? createCoalesceMaintenance({
          store,
          resultCache,
          computeLock,
          clock,
          computeWaitMaxAttempts: config.computeWaitMaxAttempts,
          computeLockTtlMs: config.computeLockTtlMs,
        })
      : undefined;
  // P3-6b: result-cache TTL sweep (independent of coalescing; gated on resultCacheTtlMs, unset ⇒ OFF).
  const resultCacheSweep =
    config.resultCacheTtlMs !== undefined
      ? createResultCacheSweep(
          { resultCache, clock, ttlMs: config.resultCacheTtlMs },
          config.resultCacheSweepIntervalMs !== undefined ? { sweepIntervalMs: config.resultCacheSweepIntervalMs } : {},
        )
      : undefined;

  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await drain();
      await reap();
      await flushOutbox();
      if (coalesceMaintain) {
        // P2-6: publish completions for followers poisoned on the wake path (compute_wait_exhausted),
        // so the owner is notified instead of learning only by polling — same as the reaper path.
        for (const job of await coalesceMaintain()) await publishCompletion(completionDeps, job);
      }
      if (resultCacheSweep) await resultCacheSweep();
    } catch (err) {
      // P2-7: contain the error. tick() is driven as `void tick()` (autoWorker kick + the setInterval
      // below), so an uncaught rejection would take down the process. Swallow-and-log; the next tick
      // retries, and terminal transitions are idempotent so a retried drain/reap emits no duplicates.
      // eslint-disable-next-line no-console
      console.error('[app] worker tick failed; will retry on the next tick', err);
    } finally {
      busy = false;
    }
  };
  const startWorker = (): void => {
    if (!timer) timer = setInterval(() => void tick(), 200);
  };
  const stopWorker = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const kick = config.autoWorker ? (): void => void tick() : (): void => {};

  const server = buildServer({
    store,
    dataPort,
    artifactStore,
    bundleStore,
    clock,
    uid,
    postWebhook,
    authToken: config.authToken,
    defaultQueueTimeoutMs: config.defaultQueueTimeoutMs,
    defaultRunTimeoutMs: config.defaultRunTimeoutMs,
    enableOverlayEngine: config.enableOverlayEngine,
    maxConcurrency: config.workerConcurrency,
    kick,
    coalesceEnabled: config.coalesceEnabled,
    computeWaitMaxAttempts: config.computeWaitMaxAttempts,
    queueMaxDepth: config.queueMaxDepth,
    queueRetryAfterS: config.queueRetryAfterS,
  });

  const dispose = async (): Promise<void> => {
    stopWorker();
    await server.close();
    if (ownedPool) await ownedPool.end();
  };

  return {
    server,
    store,
    dataPort,
    artifactStore,
    workerDeps,
    drain,
    reap,
    deliverOutbox: flushOutbox,
    tick,
    startWorker,
    stopWorker,
    dispose,
  };
}
