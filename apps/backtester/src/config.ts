import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  /** Bearer token required on every /v1 request (fail-closed on mismatch). */
  readonly authToken: string;
  /** Directory of fixture datasets (`<datasetRef>.json`) for the in-process data port. */
  readonly fixturesDir: string;
  /** Content-addressed artifact store root. */
  readonly artifactsDir: string;
  readonly defaultQueueTimeoutMs: number;
  readonly defaultRunTimeoutMs: number;
  /** When true the HTTP server runs a background worker tick; tests drain manually instead. */
  readonly autoWorker: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.BACKTESTER_HOST ?? '127.0.0.1',
    port: Number(env.BACKTESTER_PORT ?? 8080),
    authToken: env.BACKTESTER_AUTH_TOKEN ?? 'dev-token',
    fixturesDir: env.BACKTESTER_FIXTURES_DIR ?? resolve(HERE, '../fixtures/candles'),
    artifactsDir: env.BACKTESTER_ARTIFACTS_DIR ?? resolve(HERE, '../.data/artifacts'),
    defaultQueueTimeoutMs: Number(env.BACKTESTER_QUEUE_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
    defaultRunTimeoutMs: Number(env.BACKTESTER_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    autoWorker: (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false',
  };
}
