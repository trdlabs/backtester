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
  /** Historical data source: in-process fixture reader, or the networked Research Historical Data API. */
  readonly dataSource: 'fixture' | 'http';
  /** Base URL of the Research Historical Data API (required when dataSource === 'http'). */
  readonly dataApiUrl?: string;
  /** Optional bearer token for the data API (NOT exchange credentials). */
  readonly dataApiToken?: string;
  readonly dataApiPageLimit: number;
  /** Postgres connection string. When set, the service uses PgJobStore; otherwise in-memory. */
  readonly databaseUrl?: string;
  readonly defaultQueueTimeoutMs: number;
  readonly defaultRunTimeoutMs: number;
  /** When true the HTTP server runs a background worker tick; tests drain manually instead. */
  readonly autoWorker: boolean;
  /** Enable the lifted overlay engine path (engine:'overlay' runs). Default off until the verify_018 parity gate is green. */
  readonly enableOverlayEngine: boolean;
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
    dataSource: env.BACKTESTER_DATA_SOURCE === 'http' ? 'http' : 'fixture',
    ...(env.BACKTESTER_DATA_API_URL ? { dataApiUrl: env.BACKTESTER_DATA_API_URL } : {}),
    ...(env.BACKTESTER_DATA_API_TOKEN ? { dataApiToken: env.BACKTESTER_DATA_API_TOKEN } : {}),
    dataApiPageLimit: Number(env.BACKTESTER_DATA_API_PAGE_LIMIT ?? 1000),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    defaultQueueTimeoutMs: Number(env.BACKTESTER_QUEUE_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
    defaultRunTimeoutMs: Number(env.BACKTESTER_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    autoWorker: (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false',
    enableOverlayEngine: env.BACKTESTER_ENABLE_OVERLAY_ENGINE === 'true',
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
