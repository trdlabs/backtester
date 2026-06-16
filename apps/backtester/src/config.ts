import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface SandboxSettings {
  /** Absolute path to the trusted in-container harness directory (mounted :ro). */
  readonly harnessDir: string;
  readonly image: string;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly wallTimeMs: number;
  readonly tmpfsMb: number;
  readonly user: string;
}

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  /** Bearer token required on every /v1 request (fail-closed on mismatch). */
  readonly authToken: string;
  /** Directory of fixture datasets (`<datasetRef>.json`) for the in-process data port. */
  readonly fixturesDir: string;
  /** Content-addressed artifact store root. */
  readonly artifactsDir: string;
  /** Content-addressed module-bundle registry root. */
  readonly bundlesDir: string;
  /** Postgres connection string. When set, the service uses PgJobStore; otherwise in-memory. */
  readonly databaseUrl?: string;
  readonly defaultQueueTimeoutMs: number;
  readonly defaultRunTimeoutMs: number;
  /** When true the HTTP server runs a background worker tick; tests drain manually instead. */
  readonly autoWorker: boolean;
  readonly sandbox: SandboxSettings;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.BACKTESTER_HOST ?? '127.0.0.1',
    port: Number(env.BACKTESTER_PORT ?? 8080),
    authToken: env.BACKTESTER_AUTH_TOKEN ?? 'dev-token',
    fixturesDir: env.BACKTESTER_FIXTURES_DIR ?? resolve(HERE, '../fixtures/candles'),
    artifactsDir: env.BACKTESTER_ARTIFACTS_DIR ?? resolve(HERE, '../.data/artifacts'),
    bundlesDir: env.BACKTESTER_BUNDLES_DIR ?? resolve(HERE, '../.data/bundles'),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    defaultQueueTimeoutMs: Number(env.BACKTESTER_QUEUE_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
    defaultRunTimeoutMs: Number(env.BACKTESTER_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    autoWorker: (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false',
    sandbox: {
      harnessDir: env.BACKTESTER_SANDBOX_HARNESS_DIR ?? resolve(HERE, '../sandbox-harness'),
      image: env.BACKTESTER_SANDBOX_IMAGE ?? 'node:24-alpine',
      memoryMb: Number(env.BACKTESTER_SANDBOX_MEMORY_MB ?? 256),
      cpus: Number(env.BACKTESTER_SANDBOX_CPUS ?? 1),
      pidsLimit: Number(env.BACKTESTER_SANDBOX_PIDS ?? 64),
      wallTimeMs: Number(env.BACKTESTER_SANDBOX_WALL_MS ?? 10_000),
      tmpfsMb: Number(env.BACKTESTER_SANDBOX_TMPFS_MB ?? 64),
      user: env.BACKTESTER_SANDBOX_USER ?? '65534:65534',
    },
  };
}
