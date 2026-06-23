import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_SANDBOX,
  SANDBOX_IMAGE,
  type SandboxPolicy,
} from './engine/sandbox-policy';
import { mountConfigFor } from './engine/sandbox/mounts';

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

/**
 * OVERLAY sandbox config (Slice-6b-A) — separate from the Slice-3 `sandbox` block above.
 * The future overlay worker uses this to build the overlay sandbox executor:
 * `new SandboxModuleExecutor(bundle, config.overlaySandbox.policy, { harnessDir: config.overlaySandbox.harnessDir })`.
 */
export interface OverlaySandboxSettings {
  /** Absolute path to the overlay harness dir (Task-6 builds it at `apps/backtester/sandbox-harness-overlay/`). */
  readonly harnessDir: string;
  /** Pinned base image digest (`node:24-…@sha256:…`); defaults to the lifted `SANDBOX_IMAGE`. */
  readonly image: string;
  /** Policy passed straight to `SandboxModuleExecutor`; defaults to `DEFAULT_SANDBOX` with `isolation.image` = resolved `image`. */
  readonly policy: SandboxPolicy;
  /** Shared named volume for DooD bundle/harness delivery (demo). Unset → bind mode (dev). */
  readonly volume?: string;
  /** Backtester-side mountpoint of `volume` (e.g. /sandbox-shared). Set iff `volume` is set. */
  readonly volumeMountpoint?: string;
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
  /**
   * Historical data source: in-process fixture reader, the networked Research Historical Data API
   * (`http`), or the canonical `/historical/rows` rows port (`mock`/`real`). `mock` and `real` are
   * semantically distinct but share one implementation (RowsDataPort) and one URL env
   * (BACKTESTER_MOCK_PLATFORM_URL): `mock` points at trading-mock-platform, `real` at the live
   * `start-historical-http` platform. The code default stays `fixture` (safe for CI/local).
   */
  readonly dataSource: 'fixture' | 'http' | 'mock' | 'real';
  /** Base URL of the Research Historical Data API (required when dataSource === 'http'). */
  readonly dataApiUrl?: string;
  /** Optional bearer token for the data API (NOT exchange credentials). */
  readonly dataApiToken?: string;
  /** Base URL of trading-mock-platform (required when dataSource === 'mock'). */
  readonly mockPlatformUrl?: string;
  /** Bearer token for mock-platform auth (MOCK_OPS_TOKENS-verified). */
  readonly mockPlatformToken?: string;
  readonly dataApiPageLimit: number;
  /** Postgres connection string. When set, the service uses PgJobStore; otherwise in-memory. */
  readonly databaseUrl?: string;
  readonly defaultQueueTimeoutMs: number;
  readonly defaultRunTimeoutMs: number;
  /** When true the HTTP server runs a background worker tick; tests drain manually instead. */
  readonly autoWorker: boolean;
  /** Max backtests run concurrently by the in-process worker pool (>= 1; 1 = serial). */
  readonly workerConcurrency: number;
  /** Enable the lifted overlay engine path (engine:'overlay' runs). Default off until the verify_018 parity gate is green. */
  readonly enableOverlayEngine: boolean;
  readonly sandbox: SandboxSettings;
  /** OVERLAY sandbox (Slice-6b-A) — distinct from `sandbox` (Slice-3). */
  readonly overlaySandbox: OverlaySandboxSettings;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // OVERLAY sandbox (Slice-6b-A): default everything to the proven DEFAULT_SANDBOX policy,
  // overriding only image + optional resource limits from BACKTESTER_SANDBOX_OVERLAY_* env.
  const overlayImage = env.BACKTESTER_SANDBOX_OVERLAY_IMAGE ?? SANDBOX_IMAGE;
  const overlayVolume = env.BACKTESTER_SANDBOX_OVERLAY_VOLUME;
  const overlayVolumeMountpoint = env.BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT;
  mountConfigFor(overlayVolume, overlayVolumeMountpoint); // throws on half-config (fail-fast)
  const overlayPolicy: SandboxPolicy = {
    ...DEFAULT_SANDBOX,
    isolation: { ...DEFAULT_SANDBOX.isolation, image: overlayImage },
    limits: {
      ...DEFAULT_SANDBOX.limits,
      wallTimeMsPerCall: Number(
        env.BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_CALL ?? DEFAULT_SANDBOX.limits.wallTimeMsPerCall,
      ),
      wallTimeMsPerSession: Number(
        env.BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION ?? DEFAULT_SANDBOX.limits.wallTimeMsPerSession,
      ),
      memoryBytes: env.BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB
        ? Number(env.BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB) * 1024 * 1024
        : DEFAULT_SANDBOX.limits.memoryBytes,
      cpus: Number(env.BACKTESTER_SANDBOX_OVERLAY_CPUS ?? DEFAULT_SANDBOX.limits.cpus),
    },
    ...(env.BACKTESTER_SANDBOX_OVERLAY_PIDS
      ? {
          isolation: {
            ...DEFAULT_SANDBOX.isolation,
            image: overlayImage,
            pidsLimit: Number(env.BACKTESTER_SANDBOX_OVERLAY_PIDS),
          },
        }
      : {}),
  };
  const workerConcurrencyRaw = Number(env.WORKER_CONCURRENCY ?? 4);
  const workerConcurrency = Number.isFinite(workerConcurrencyRaw)
    ? Math.max(1, Math.floor(workerConcurrencyRaw))
    : 4;
  return {
    host: env.BACKTESTER_HOST ?? '127.0.0.1',
    port: Number(env.BACKTESTER_PORT ?? 8080),
    authToken: env.BACKTESTER_AUTH_TOKEN ?? 'dev-token',
    fixturesDir: env.BACKTESTER_FIXTURES_DIR ?? resolve(HERE, '../fixtures/candles'),
    artifactsDir: env.BACKTESTER_ARTIFACTS_DIR ?? resolve(HERE, '../.data/artifacts'),
    bundlesDir: env.BACKTESTER_BUNDLES_DIR ?? resolve(HERE, '../.data/bundles'),
    dataSource:
      env.BACKTESTER_DATA_SOURCE === 'http'  ? 'http'    :
      env.BACKTESTER_DATA_SOURCE === 'mock'  ? 'mock'    :
      env.BACKTESTER_DATA_SOURCE === 'real'  ? 'real'    :
                                               'fixture',
    ...(env.BACKTESTER_DATA_API_URL       ? { dataApiUrl:       env.BACKTESTER_DATA_API_URL }       : {}),
    ...(env.BACKTESTER_DATA_API_TOKEN     ? { dataApiToken:     env.BACKTESTER_DATA_API_TOKEN }     : {}),
    ...(env.BACKTESTER_MOCK_PLATFORM_URL   ? { mockPlatformUrl:   env.BACKTESTER_MOCK_PLATFORM_URL }   : {}),
    ...(env.BACKTESTER_MOCK_PLATFORM_TOKEN ? { mockPlatformToken: env.BACKTESTER_MOCK_PLATFORM_TOKEN } : {}),
    dataApiPageLimit: Number(env.BACKTESTER_DATA_API_PAGE_LIMIT ?? 1000),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    defaultQueueTimeoutMs: Number(env.BACKTESTER_QUEUE_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
    defaultRunTimeoutMs: Number(env.BACKTESTER_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    autoWorker: (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false',
    workerConcurrency,
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
    overlaySandbox: {
      harnessDir: env.BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR ?? resolve(HERE, '../sandbox-harness-overlay'),
      image: overlayImage,
      policy: overlayPolicy,
      ...(overlayVolume !== undefined ? { volume: overlayVolume } : {}),
      ...(overlayVolumeMountpoint !== undefined ? { volumeMountpoint: overlayVolumeMountpoint } : {}),
    },
  };
}
