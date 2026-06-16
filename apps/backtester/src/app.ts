// Composition root. Selects PgJobStore when a database URL is configured (Slice 2), else in-memory.
// Tests inject a store (and a fake webhook poster) via overrides and drive drain/reap/outbox manually.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildServer } from './api/server';
import type { AppConfig } from './config';
import { FileArtifactStore, type ArtifactStore } from './artifacts/store';
import { FixtureDataPort, type BacktesterDataPort } from './data/reader';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import {
  defaultWebhookPoster,
  deliverOutbox,
  reapAndPublish,
  type CompletionDeps,
  type WebhookPoster,
} from './jobs/completion';
import { InMemoryJobStore, type JobStore } from './jobs/job-store';
import { PgJobStore } from './jobs/pg-job-store';
import { drainQueue, type WorkerDeps } from './jobs/worker';

export interface BuildAppOptions {
  store?: JobStore;
  dataPort?: BacktesterDataPort;
  artifactStore?: ArtifactStore;
  clock?: () => number;
  uid?: () => string;
  postWebhook?: WebhookPoster;
}

export interface AppHandles {
  server: FastifyInstance;
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  drain: () => Promise<number>;
  reap: () => Promise<unknown>;
  deliverOutbox: () => Promise<number>;
  startWorker: () => void;
  stopWorker: () => void;
  dispose: () => Promise<void>;
}

export async function buildApp(config: AppConfig, overrides: BuildAppOptions = {}): Promise<AppHandles> {
  let ownedPool: Pool | undefined;
  let store = overrides.store;
  if (!store) {
    if (config.databaseUrl) {
      ownedPool = createPool(config.databaseUrl);
      await migrate(ownedPool);
      store = new PgJobStore(ownedPool);
    } else {
      store = new InMemoryJobStore();
    }
  }

  const dataPort = overrides.dataPort ?? new FixtureDataPort(config.fixturesDir);
  const artifactStore = overrides.artifactStore ?? new FileArtifactStore(config.artifactsDir);
  const clock = overrides.clock ?? ((): number => Date.now());
  const uid = overrides.uid ?? ((): string => randomUUID());
  const postWebhook = overrides.postWebhook ?? defaultWebhookPoster();

  const completionDeps: CompletionDeps = { store, clock, uid, postWebhook };
  const workerDeps: WorkerDeps = { ...completionDeps, dataPort, artifactStore };

  const drain = (): Promise<number> => drainQueue(workerDeps);
  const reap = (): Promise<unknown> => reapAndPublish(completionDeps);
  const flushOutbox = (): Promise<number> => deliverOutbox(completionDeps);

  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await drain();
      await reap();
      await flushOutbox();
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
    clock,
    uid,
    postWebhook,
    authToken: config.authToken,
    defaultQueueTimeoutMs: config.defaultQueueTimeoutMs,
    defaultRunTimeoutMs: config.defaultRunTimeoutMs,
    maxConcurrency: 1,
    kick,
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
    drain,
    reap,
    deliverOutbox: flushOutbox,
    startWorker,
    stopWorker,
    dispose,
  };
}
