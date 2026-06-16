// Composition root — wires the in-memory store, fixture data port, artifact store, worker, and HTTP
// server. Tests pass overrides (in-memory artifact store, fixed clock/uid) and drain the queue
// manually; production uses the defaults and a background worker tick.

import { randomUUID } from 'node:crypto';
import { buildServer } from './api/server';
import type { AppConfig } from './config';
import { FileArtifactStore, type ArtifactStore } from './artifacts/store';
import { FixtureDataPort, type BacktesterDataPort } from './data/reader';
import { InMemoryJobStore, type JobStore } from './jobs/job-store';
import { drainQueue, type WorkerDeps } from './jobs/worker';
import type { FastifyInstance } from 'fastify';

export interface BuildAppOptions {
  store?: JobStore;
  dataPort?: BacktesterDataPort;
  artifactStore?: ArtifactStore;
  clock?: () => number;
  uid?: () => string;
}

export interface AppHandles {
  server: FastifyInstance;
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  drain: () => Promise<number>;
  startWorker: () => void;
  stopWorker: () => void;
}

export function buildApp(config: AppConfig, overrides: BuildAppOptions = {}): AppHandles {
  const store = overrides.store ?? new InMemoryJobStore();
  const dataPort = overrides.dataPort ?? new FixtureDataPort(config.fixturesDir);
  const artifactStore = overrides.artifactStore ?? new FileArtifactStore(config.artifactsDir);
  const clock = overrides.clock ?? (() => Date.now());
  const uid = overrides.uid ?? ((): string => randomUUID());

  const workerDeps: WorkerDeps = { store, dataPort, artifactStore, clock, uid };
  const drain = (): Promise<number> => drainQueue(workerDeps);

  let timer: NodeJS.Timeout | undefined;
  let draining = false;
  const tick = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      await drain();
    } finally {
      draining = false;
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
    authToken: config.authToken,
    defaultQueueTimeoutMs: config.defaultQueueTimeoutMs,
    defaultRunTimeoutMs: config.defaultRunTimeoutMs,
    maxConcurrency: 1,
    kick,
  });

  return { server, store, dataPort, artifactStore, drain, startWorker, stopWorker };
}
