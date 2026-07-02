// Worker-node entrypoint: drain the shared Postgres queue (no HTTP). Run M of these against one
// DATABASE_URL alongside one API node (BACKTESTER_AUTO_WORKER=false). Multi-process REQUIRES Postgres.

import { buildApp, type AppHandles } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { runWorkerLoop } from './jobs/worker.js';
import { startWorkerHealthServer } from './jobs/worker-health.js';
import { pathToFileURL } from 'node:url';

export function assertWorkerConfig(config: AppConfig): void {
  if (!config.databaseUrl) {
    throw new Error(
      'worker-main requires DATABASE_URL (multi-process drains the shared Postgres queue; ' +
        'the in-memory store is per-process and cannot be shared).',
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertWorkerConfig(config);
  const app: AppHandles = await buildApp(config);
  const ac = new AbortController();
  const deps = app.workerDeps; // exposed by buildApp (Step 4)
  const lease = { workerId: config.workerId, ttlMs: config.workerLeaseTtlMs, maxAttempts: config.workerMaxAttempts };

  let loopDone = false;
  let draining = false;
  const health =
    config.workerHealthPort !== undefined
      ? await startWorkerHealthServer(
          config.workerHealthPort,
          {
            live: () => !loopDone,
            ready: () => !draining,
          },
          deps.obs,
        )
      : undefined;

  // eslint-disable-next-line no-console
  console.log(`trading-backtester worker ${config.workerId} draining (concurrency=${config.workerConcurrency})`);
  const loop = runWorkerLoop(
    { ...deps, lease },
    {
      concurrency: config.workerConcurrency,
      heartbeatMs: config.workerHeartbeatMs,
      pollMs: config.workerPollMs,
      signal: ac.signal,
    },
  ).finally(() => {
    loopDone = true;
  });

  const shutdown = async (): Promise<void> => {
    draining = true; // readiness → 503 immediately; liveness stays 200 during graceful drain
    ac.abort();
    await loop;
    await app.dispose();
    await health?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await loop;
}

// Run only when executed directly — NOT when imported by the unit test. Compare this module's URL
// to argv[1] so it works under both `tsx src/worker-main.ts` (.ts) and `node dist/worker-main.js`
// (the old `.endsWith('worker-main.js')` check silently no-op'd under tsx → `pnpm worker` did nothing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
