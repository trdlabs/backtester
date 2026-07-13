import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';

import {
  DEFAULT_SANDBOX,
  SANDBOX_IMAGE,
  type SandboxPolicy,
} from './engine/sandbox-policy';
import { mountConfigFor } from './engine/sandbox/mounts';
import { NoveltyConfigError } from './engine/novelty';
import type { S3Settings } from './storage/s3-client';

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
  /** Object-store backend for artifacts + bundles. Default 'filesystem' (host-local, dev/CI). */
  readonly storeBackend: 'filesystem' | 's3';
  /** S3-compatible settings; present only when storeBackend === 's3'. */
  readonly s3?: S3Settings;
  /**
   * Historical data source: in-process fixture reader, the networked Research Historical Data API
   * (`http`), or the canonical `/historical/rows` rows port (`mock`/`real`). `mock` and `real` are
   * semantically distinct and share one implementation (RowsDataPort) but each has its OWN URL/token
   * env pair: `mock` points at trading-mock-platform via BACKTESTER_MOCK_PLATFORM_URL/_TOKEN, `real`
   * at the live `start-historical-http` platform via BACKTESTER_REAL_PLATFORM_URL/_TOKEN. `real` is
   * the recommended production posture, but the code default stays `fixture` (safe for CI/local).
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
  /** Base URL of the live real platform (required when dataSource === 'real'). */
  readonly realPlatformUrl?: string;
  /** Bearer token for real-platform auth (required when dataSource === 'real'). */
  readonly realPlatformToken?: string;
  readonly dataApiPageLimit: number;
  /** Postgres connection string. When set, the service uses PgJobStore; otherwise in-memory. */
  readonly databaseUrl?: string;
  /** Max pooled Pg connections per process (pg default 10; raise with worker fleet math). */
  readonly pgPoolMax: number;
  /** statement_timeout (ms) on app-pool connections; 0 = off. Migrations are exempt by construction. */
  readonly pgStatementTimeoutMs: number;
  readonly defaultQueueTimeoutMs: number;
  readonly defaultRunTimeoutMs: number;
  /** When true the HTTP server runs a background worker tick; tests drain manually instead. */
  readonly autoWorker: boolean;
  /** Max backtests run concurrently by the in-process worker pool (>= 1; 1 = serial). */
  readonly workerConcurrency: number;
  /** Stable id of this worker process (lease owner); default `${hostname}:${pid}`. */
  readonly workerId: string;
  /** Lease TTL (ms) set on claim; clamped to >= 3 * workerHeartbeatMs. */
  readonly workerLeaseTtlMs: number;
  /** Heartbeat interval (ms): workers renew their in-flight leases this often. */
  readonly workerHeartbeatMs: number;
  /** Max claim attempts before a repeatedly-orphaned job is failed (poison). */
  readonly workerMaxAttempts: number;
  /** Idle poll interval (ms) when the queue is empty. */
  readonly workerPollMs: number;
  /** Optional TCP port for the worker health server (/healthz + /readyz). Unset ⇒ no server. */
  readonly workerHealthPort?: number;
  /** Enable the lifted overlay engine path (engine:'overlay' runs). Default off until the verify_018 parity gate is green. */
  readonly enableOverlayEngine: boolean;
  /** Enable the fingerprint-based result-dedup cache. Default false (dark launch). */
  readonly dedupEnabled: boolean;
  /** Enable per-job observability (terminal log line + /statsz). Default off. */
  readonly jobObs: boolean;
  /** Enable in-flight request coalescing (leader/follower). Default off; effective only with dedupEnabled. */
  readonly coalesceEnabled: boolean;
  /** 17b: batch flat-stretch onBarClose calls into one sandbox message. Default off (dark launch). */
  readonly barBatching: boolean;
  /** 17d: bar-major execution mode — one bar across all symbols before advancing. Default off (dark launch). */
  readonly barMajor: boolean;
  /** Slice B: collapse bar-major per-bar IPC into 3-phase batched transport. Pure sub-mode of barMajor — inert unless barMajor is also on. Default off (dark launch). */
  readonly barMajorBatch: boolean;
  /** 17b: max bars per hookBatch (clamped >= 2). */
  readonly batchBars: number;
  /** 17c: run all symbols of a bundle in ONE container (N per-symbol instances). Default off (dark launch). */
  readonly universeSession: boolean;
  /** 17c: reject a universe run whose symbol count exceeds this (pre-exec validation). */
  readonly universeMaxN: number;
  /** 17c: per-container memory floor (MiB), added to universeMemPerSymbolMb × N. */
  readonly universeMemBaseMb: number;
  /** 17c: per-symbol memory (MiB) added on top of the base for a universe container. */
  readonly universeMemPerSymbolMb: number;
  /** Queue-wake LISTEN/NOTIFY enabled (Phase D item 16). Default off. */
  readonly queueNotify: boolean;
  /** E2: trial ledger + advisory Deflated Sharpe enabled. Default off (dark launch). */
  readonly trialLedger: boolean;
  /** E2: N at/above which V[SR] switches asymptotic→empirical. Default 5. */
  readonly trialEmpiricalMinN: number;
  /** E4a: held-out OOS qualification marker enabled. Default off (dark launch). */
  readonly holdout: boolean;
  /** E4a: held-out window = last `holdoutFraction` of coverage. Only read when `holdout` is on. */
  readonly holdoutFraction: number;
  /** E1b: structured run diagnostics enabled. Default off (dark launch). */
  readonly runDiagnostics: boolean;
  /** E1b: `underpowered` flag threshold (trades). Default 30. */
  readonly diagMinTrades: number;
  /** E1b: `single_trade_dominated` flag threshold (% of gross profit). Default 80. */
  readonly diagConcentrationPct: number;
  /** E5a: behavioral-novelty gate enabled. Default off (dark launch). */
  readonly novelty: boolean;
  /** E5a: `behavioralDuplicate` when maxAbsCorrelation ≥ this. Validated in [0,1] when enabled. Default 0.80. */
  readonly noveltyCorrThreshold: number;
  /** E5a: minimum shared UTC days for a valid Pearson. Validated integer ≥ 1 when enabled. Default 30. */
  readonly noveltyMinOverlapDays: number;
  /** E3b: walk-forward per-fold execution enabled. Default off (dark launch). */
  readonly walkForward: boolean;
  /** E3b: policy cap on fold count (safe integer >= 1). Default 20. */
  readonly walkForwardMaxFolds: number;
  /** Compute-lock TTL (ms). Default = workerLeaseTtlMs. */
  readonly computeLockTtlMs: number;
  /** compute_wait_attempts poison cap. Default 3. */
  readonly computeWaitMaxAttempts: number;
  /** Queued-jobs cap; a NEW submit beyond it gets 429 queue_full. 0 = unlimited. */
  readonly queueMaxDepth: number;
  /** Retry-After (seconds) advertised on 429. */
  readonly queueRetryAfterS: number;
  readonly sandbox: SandboxSettings;
  /** OVERLAY sandbox (Slice-6b-A) — distinct from `sandbox` (Slice-3). */
  readonly overlaySandbox: OverlaySandboxSettings;
  /**
   * PEM-encoded PKCS8 Ed25519 private key used to sign backtest evidence.
   * Source: env `BT_EVIDENCE_SIGNING_KEY`. Absent ⇒ evidence signing is OFF.
   * Do NOT generate ephemeral keys on startup — an ephemeral keyId is not in the platform allowlist.
   */
  readonly evidenceSigningKeyPem?: string;
}

/**
 * Parse a non-negative numeric env var, clamping to `[0, ∞)`. Falls back to `def` ONLY on
 * undefined / blank / NaN — a valid, explicit `0` is preserved (unlike the `Math.max(0, …) || def`
 * idiom used for floor-≥1 knobs, which silently coerces a clamped 0 back to the default). Used for
 * the diagnostics thresholds where `0` is a legitimate operator policy (minTrades 0 = disable the
 * underpowered flag; concentrationPct 0 = maximum single-trade-dominated sensitivity).
 */
function nonNegNumEnv(raw: string | undefined, def: number, opts?: { int?: boolean }): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const clamped = Math.max(0, n);
  return opts?.int ? Math.floor(clamped) : clamped;
}

/** A host bind is loopback-only (safe to run with the dev default token) when it is 127.0.0.0/8,
 *  ::1, or localhost. Everything else (0.0.0.0, a concrete external address, a hostname) is treated as
 *  externally reachable and requires an explicit auth token. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
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
  // Fail-fast: bar-major and bar-batching are mutually exclusive.
  if (env.BACKTESTER_BAR_MAJOR === 'true' && env.BACKTESTER_BAR_BATCHING === 'true') {
    throw new Error('BACKTESTER_BAR_MAJOR and BACKTESTER_BAR_BATCHING cannot both be enabled');
  }
  // Fail-fast (E4a): a bad holdout fraction must surface, not be silently clamped.
  if (env.BACKTESTER_HOLDOUT_ENABLED === 'true') {
    const f = Number(env.BACKTESTER_HOLDOUT_FRACTION);
    if (!Number.isFinite(f) || f <= 0 || f >= 1) {
      throw new Error('BACKTESTER_HOLDOUT_FRACTION must be a finite number in (0,1) when BACKTESTER_HOLDOUT_ENABLED');
    }
  }
  // Fail-fast (E5a): thresholds only meaningful in-range; validate only when the gate is on. When off,
  // the values are normalized to defaults below (never NaN), so a bad env never poisons the config.
  const noveltyEnabled = env.BACKTESTER_NOVELTY_ENABLED === 'true';
  const noveltyThresholdRaw = Number(env.BACKTESTER_NOVELTY_CORR_THRESHOLD);
  const noveltyOverlapRaw = Number(env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS);
  if (noveltyEnabled) {
    // Only validate a field the caller actually set — an unset field falls back to its default
    // below and must not be rejected just because the *other* field was the one under test.
    if (
      env.BACKTESTER_NOVELTY_CORR_THRESHOLD !== undefined &&
      (!Number.isFinite(noveltyThresholdRaw) || noveltyThresholdRaw < 0 || noveltyThresholdRaw > 1)
    ) {
      throw new NoveltyConfigError('BACKTESTER_NOVELTY_CORR_THRESHOLD must be a number in [0,1] when BACKTESTER_NOVELTY_ENABLED');
    }
    if (
      env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS !== undefined &&
      (!Number.isInteger(noveltyOverlapRaw) || noveltyOverlapRaw < 1)
    ) {
      throw new NoveltyConfigError('BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS must be an integer ≥ 1 when BACKTESTER_NOVELTY_ENABLED');
    }
  }
  const workerConcurrencyRaw = Number(env.WORKER_CONCURRENCY ?? 4);
  const workerConcurrency = Number.isFinite(workerConcurrencyRaw)
    ? Math.max(1, Math.floor(workerConcurrencyRaw))
    : 4;
  const heartbeat = Math.max(1000, Math.floor(Number(env.WORKER_HEARTBEAT_MS ?? 10_000)) || 10_000);
  const leaseTtl = Math.max(
    3 * heartbeat,
    Math.floor(Number(env.WORKER_LEASE_TTL_MS ?? 30_000)) || 30_000,
  );
  const maxAttempts = Math.max(1, Math.floor(Number(env.WORKER_MAX_ATTEMPTS ?? 3)) || 3);
  const pollMs = Math.max(50, Math.floor(Number(env.WORKER_POLL_MS ?? 500)) || 500);
  const workerHealthPortRaw = env.WORKER_HEALTH_PORT ? Number(env.WORKER_HEALTH_PORT) : undefined;
  const workerHealthPort =
    workerHealthPortRaw !== undefined && Number.isFinite(workerHealthPortRaw)
      ? Math.floor(workerHealthPortRaw)
      : undefined;
  const workerId = env.WORKER_ID ?? `${hostname()}:${process.pid}`;
  const rawStoreBackend = env.BACKTESTER_STORE_BACKEND;
  if (rawStoreBackend && rawStoreBackend !== 'filesystem' && rawStoreBackend !== 's3') {
    throw new Error(
      `invalid BACKTESTER_STORE_BACKEND '${rawStoreBackend}' (expected 'filesystem' or 's3')`,
    );
  }
  const storeBackend: 'filesystem' | 's3' = rawStoreBackend === 's3' ? 's3' : 'filesystem';
  let s3: S3Settings | undefined;
  if (storeBackend === 's3') {
    const endpoint = env.BACKTESTER_S3_ENDPOINT;
    const bucket = env.BACKTESTER_S3_BUCKET;
    const accessKeyId = env.BACKTESTER_S3_ACCESS_KEY;
    const secretAccessKey = env.BACKTESTER_S3_SECRET_KEY;
    const missing = (
      [
        ['BACKTESTER_S3_ENDPOINT', endpoint],
        ['BACKTESTER_S3_BUCKET', bucket],
        ['BACKTESTER_S3_ACCESS_KEY', accessKeyId],
        ['BACKTESTER_S3_SECRET_KEY', secretAccessKey],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(`store backend 's3' requires ${missing.join(', ')}`);
    }
    s3 = {
      endpoint: endpoint!,
      bucket: bucket!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      // MinIO is the first-class target: default true unless explicitly disabled (AWS ⇒ 'false').
      forcePathStyle: env.BACKTESTER_S3_FORCE_PATH_STYLE !== 'false',
      ...(env.BACKTESTER_S3_REGION ? { region: env.BACKTESTER_S3_REGION } : {}),
    };
  }
  const realPlatformUrl = env.BACKTESTER_REAL_PLATFORM_URL?.trim();
  const realPlatformToken = env.BACKTESTER_REAL_PLATFORM_TOKEN?.trim();
  const dataSourceResolved =
    env.BACKTESTER_DATA_SOURCE === 'http' ? 'http' :
    env.BACKTESTER_DATA_SOURCE === 'mock' ? 'mock' :
    env.BACKTESTER_DATA_SOURCE === 'real' ? 'real' : 'fixture';
  if (dataSourceResolved === 'real' && (!realPlatformUrl?.trim() || !realPlatformToken?.trim())) {
    throw new Error(
      'BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real',
    );
  }
  // P2-10: never ship a usable default auth secret on an externally-reachable bind. On a non-loopback
  // host BACKTESTER_AUTH_TOKEN MUST be set explicitly (fail-closed, mirrors the DATA_SOURCE=real guard);
  // on loopback the dev default is allowed (a loud warning nudges non-local deployments to set one).
  const host = env.BACKTESTER_HOST ?? '127.0.0.1';
  const authTokenSet = typeof env.BACKTESTER_AUTH_TOKEN === 'string' && env.BACKTESTER_AUTH_TOKEN.length > 0;
  if (!authTokenSet && !isLoopbackHost(host)) {
    throw new Error(
      `BACKTESTER_AUTH_TOKEN is required when BACKTESTER_HOST (${host}) is not a loopback address — ` +
        'refusing to expose the API with the insecure default token',
    );
  }
  if (!authTokenSet) {
    // eslint-disable-next-line no-console
    console.warn('[config] BACKTESTER_AUTH_TOKEN is unset — using the insecure dev default; set it for any non-local deployment');
  }
  return {
    host,
    port: Number(env.BACKTESTER_PORT ?? 8080),
    authToken: authTokenSet ? env.BACKTESTER_AUTH_TOKEN! : 'dev-token',
    fixturesDir: env.BACKTESTER_FIXTURES_DIR ?? resolve(HERE, '../fixtures/candles'),
    artifactsDir: env.BACKTESTER_ARTIFACTS_DIR ?? resolve(HERE, '../.data/artifacts'),
    bundlesDir: env.BACKTESTER_BUNDLES_DIR ?? resolve(HERE, '../.data/bundles'),
    storeBackend,
    ...(s3 ? { s3 } : {}),
    dataSource: dataSourceResolved,
    ...(env.BACKTESTER_DATA_API_URL       ? { dataApiUrl:       env.BACKTESTER_DATA_API_URL }       : {}),
    ...(env.BACKTESTER_DATA_API_TOKEN     ? { dataApiToken:     env.BACKTESTER_DATA_API_TOKEN }     : {}),
    ...(env.BACKTESTER_MOCK_PLATFORM_URL   ? { mockPlatformUrl:   env.BACKTESTER_MOCK_PLATFORM_URL }   : {}),
    ...(env.BACKTESTER_MOCK_PLATFORM_TOKEN ? { mockPlatformToken: env.BACKTESTER_MOCK_PLATFORM_TOKEN } : {}),
    ...(realPlatformUrl   ? { realPlatformUrl }   : {}),
    ...(realPlatformToken ? { realPlatformToken } : {}),
    dataApiPageLimit: Number(env.BACKTESTER_DATA_API_PAGE_LIMIT ?? 1000),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    pgPoolMax: Math.max(1, Number(env.BACKTESTER_PG_POOL_MAX ?? 10) || 10),
    pgStatementTimeoutMs: Math.max(0, Number(env.BACKTESTER_PG_STATEMENT_TIMEOUT_MS ?? 0) || 0),
    defaultQueueTimeoutMs: Number(env.BACKTESTER_QUEUE_TIMEOUT_MS ?? 6 * 60 * 60 * 1000),
    defaultRunTimeoutMs: Number(env.BACKTESTER_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    autoWorker: (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false',
    workerConcurrency,
    workerId,
    workerLeaseTtlMs: leaseTtl,
    workerHeartbeatMs: heartbeat,
    workerMaxAttempts: maxAttempts,
    workerPollMs: pollMs,
    ...(workerHealthPort !== undefined ? { workerHealthPort } : {}),
    enableOverlayEngine: env.BACKTESTER_ENABLE_OVERLAY_ENGINE === 'true',
    dedupEnabled: env.BACKTESTER_DEDUP_ENABLED === 'true',
    jobObs: env.BACKTESTER_JOB_OBS === 'true',
    coalesceEnabled: env.BACKTESTER_COALESCE_ENABLED === 'true',
    barBatching: env.BACKTESTER_BAR_BATCHING === 'true',
    barMajor: env.BACKTESTER_BAR_MAJOR === 'true',
    barMajorBatch: env.BACKTESTER_BAR_MAJOR_BATCH === 'true',
    // `|| 64` OUTSIDE the max: garbage → NaN → 64, while '0'/'1' clamp to the floor 2 (a falsy-zero
    // inside would silently resolve '0' to 64 — the master flag, not batchBars, is the off switch).
    batchBars: Math.max(2, Math.floor(Number(env.BACKTESTER_BATCH_BARS ?? 64))) || 64,
    universeSession: env.BACKTESTER_UNIVERSE_SESSION === 'true',
    universeMaxN: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MAX_N ?? 64))) || 64,
    universeMemBaseMb: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MEM_BASE_MB ?? 128))) || 128,
    universeMemPerSymbolMb: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB ?? 8))) || 8,
    queueNotify: env.BACKTESTER_QUEUE_NOTIFY === 'true',
    trialLedger: env.BACKTESTER_TRIAL_LEDGER === 'true',
    trialEmpiricalMinN: Math.max(2, Math.floor(Number(env.BACKTESTER_TRIAL_EMPIRICAL_MIN_N ?? 5))) || 5,
    holdout: env.BACKTESTER_HOLDOUT_ENABLED === 'true',
    holdoutFraction: Number(env.BACKTESTER_HOLDOUT_FRACTION) || 0.2,
    runDiagnostics: env.BACKTESTER_RUN_DIAGNOSTICS === 'true',
    diagMinTrades: nonNegNumEnv(env.BACKTESTER_DIAG_MIN_TRADES, 30, { int: true }),
    diagConcentrationPct: nonNegNumEnv(env.BACKTESTER_DIAG_CONCENTRATION_PCT, 80),
    novelty: noveltyEnabled,
    noveltyCorrThreshold:
      env.BACKTESTER_NOVELTY_CORR_THRESHOLD !== undefined && Number.isFinite(noveltyThresholdRaw)
        ? noveltyThresholdRaw
        : 0.8,
    noveltyMinOverlapDays:
      env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS !== undefined && Number.isInteger(noveltyOverlapRaw)
        ? noveltyOverlapRaw
        : 30,
    walkForward: env.BACKTESTER_WALK_FORWARD_ENABLED === 'true',
    walkForwardMaxFolds: (() => {
      const n = Number(env.BACKTESTER_WALK_FORWARD_MAX_FOLDS);
      return Number.isSafeInteger(n) && n >= 1 ? n : 20;
    })(),
    computeLockTtlMs: env.BACKTESTER_COMPUTE_LOCK_TTL_MS ? Number(env.BACKTESTER_COMPUTE_LOCK_TTL_MS) : leaseTtl,
    computeWaitMaxAttempts: env.BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS ? Number(env.BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS) : 3,
    queueMaxDepth: Math.max(0, Number(env.BACKTESTER_QUEUE_MAX_DEPTH ?? 0) || 0),
    queueRetryAfterS: Math.max(1, Number(env.BACKTESTER_QUEUE_RETRY_AFTER_S ?? 30) || 30),
    ...(env.BT_EVIDENCE_SIGNING_KEY ? { evidenceSigningKeyPem: env.BT_EVIDENCE_SIGNING_KEY } : {}),
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
