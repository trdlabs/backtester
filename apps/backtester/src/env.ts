// env.ts — ЕДИНСТВЕННАЯ точка чтения process.env в репо (контракт env-schema.1,
// control-center docs/architecture/contracts/env-schema.md; инициатива env-catalog, item 3).
//
// Здесь живут:
//  - реестр ENV_VARS: каждая переменная окружения репо с типом, дефолтом, описанием,
//    признаками secret/flag и владельцем (owner_unit);
//  - zod-валидация raw-env (`loadEnv`): fail-fast на старте, ВСЕ ошибки разом (safeParse),
//    зеркалирующая существующие fail-fast проверки `loadConfig` (accept-set идентичен —
//    ничего не ослаблено и не ужесточено; типизированный доступ к значениям остаётся
//    за `loadConfig` → AppConfig, который парсит из снапшота, выданного этим модулем);
//  - детерминированный экспорт документа `env-schema.1` (`envSchemaDocument` /
//    `renderEnvSchemaJson`, команда `npm run env:schema`).
//
// Прямые чтения process.env вне этого модуля — только явный хвост (см. docs/ROADMAP.md,
// env-catalog item 3): apps/backtester/test/** и sandbox-harness-overlay/deny-shims.mjs
// (defense-in-depth shim, не потребитель переменных). Advisory-отчёт: npm run env:advisory.

import { isIP } from 'node:net';
import { z } from 'zod';

export const ENV_SCHEMA_VERSION = 'env-schema.1' as const;
export const REPO_ID = 'trading-backtester';
export const GENERATED_FROM = 'apps/backtester/src/env.ts';

export type EnvVarType = 'string' | 'int' | 'float' | 'bool' | 'enum' | 'url' | 'duration_ms' | 'csv';
export type FlagState = 'off' | 'log' | 'enforce';

export interface EnvVarSpec {
  readonly name: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  /** Дефолт строкой, ровно как в .env; null = дефолта нет (в т.ч. вычисляемые дефолты — см. description). */
  readonly default: string | null;
  readonly description: string;
  readonly secret: boolean;
  readonly flag: boolean;
  readonly enumValues?: readonly string[];
  readonly flagStates?: readonly FlagState[];
  readonly defaultState?: FlagState;
  readonly ownerUnit: string;
  readonly consumers: readonly string[];
}

/** Экспортный элемент документа env-schema.1 (snake_case по контракту). */
export interface EnvSchemaVariable {
  name: string;
  type: EnvVarType;
  required: boolean;
  default: string | null;
  description: string;
  secret: boolean;
  flag: boolean;
  enum_values?: string[];
  flag_states?: FlagState[];
  default_state?: FlagState;
  owner_unit: string;
  consumers: string[];
}

export interface EnvSchemaDocument {
  schema_version: typeof ENV_SCHEMA_VERSION;
  repo: string;
  generated_from: string;
  variables: EnvSchemaVariable[];
}

// ---------------------------------------------------------------------------
// Реестр. Логические юниты (у backtester нет постоянных systemd-юнитов на VPS —
// прод-запуск on-demand): backtester-service (API-нода + общий config),
// backtester-worker (worker-main), backtester-data-api (референс data-api),
// backtester-tests (переменные, читаемые только тестами).
// ---------------------------------------------------------------------------

const SERVICE = 'backtester-service';
const WORKER = 'backtester-worker';
const DATA_API = 'backtester-data-api';
const TESTS = 'backtester-tests';
const DEVTOOLS = 'backtester-devtools';

const CONFIG = 'apps/backtester/src/config.ts';

interface VarOpts {
  readonly secret?: boolean;
  readonly enumValues?: readonly string[];
  readonly ownerUnit?: string;
  readonly consumers?: readonly string[];
}

function envVar(
  name: string,
  type: EnvVarType,
  def: string | null,
  description: string,
  opts: VarOpts = {},
): EnvVarSpec {
  return {
    name,
    type,
    required: false,
    default: opts.secret ? null : def,
    description,
    secret: opts.secret ?? false,
    flag: false,
    ...(opts.enumValues ? { enumValues: opts.enumValues } : {}),
    ownerUnit: opts.ownerUnit ?? SERVICE,
    consumers: opts.consumers ?? [CONFIG],
  };
}

/** Деплой-таймовый фичефлаг E4b-паттерна. .env-форма — bool (true/false); default в схеме — null
 *  (правило валидатора: default, если задан, равен default_state), фактическое состояние несёт
 *  default_state: 'off' = выключен без переменной, 'enforce' = включён без переменной. */
function flagVar(
  name: string,
  description: string,
  defaultState: Extract<FlagState, 'off' | 'enforce'> = 'off',
  opts: Pick<VarOpts, 'ownerUnit' | 'consumers'> = {},
): EnvVarSpec {
  return {
    name,
    type: 'bool',
    required: false,
    default: null,
    description,
    secret: false,
    flag: true,
    flagStates: ['off', 'enforce'],
    defaultState,
    ownerUnit: opts.ownerUnit ?? SERVICE,
    consumers: opts.consumers ?? [CONFIG],
  };
}

export const ENV_VARS: readonly EnvVarSpec[] = [
  envVar('BACKTESTER_ARTIFACTS_DIR', 'string', null, 'Корень content-addressed стора артефактов; дефолт вычисляется: apps/backtester/.data/artifacts.'),
  envVar('BACKTESTER_AUTH_TOKEN', 'string', null, 'Bearer-токен /v1 API (fail-closed). На loopback допустим dev-дефолт; на не-loopback BACKTESTER_HOST обязателен (fail-fast, P2-10).', { secret: true }),
  envVar('BACKTESTER_AUTO_WORKER', 'bool', 'true', 'HTTP-нода запускает фоновый worker-tick; false — только API (multi-process с worker-main).'),
  flagVar('BACKTESTER_BAR_BATCHING', '17b: батчинг flat-stretch onBarClose в одно sandbox-сообщение (dark launch). Взаимоисключим с BACKTESTER_BAR_MAJOR (fail-fast).'),
  flagVar('BACKTESTER_BAR_MAJOR', '17d: bar-major исполнение — один бар по всем символам до продвижения (dark launch). Взаимоисключим с BACKTESTER_BAR_BATCHING (fail-fast).'),
  flagVar('BACKTESTER_BAR_MAJOR_BATCH', 'Slice B: 3-фазный батч-транспорт per-bar IPC bar-major; чистый суб-режим BACKTESTER_BAR_MAJOR (инертен без него).'),
  envVar('BACKTESTER_BATCH_BARS', 'int', '64', '17b: максимум баров на hookBatch (клампится к >= 2; мусор → 64).'),
  envVar('BACKTESTER_BUNDLES_DIR', 'string', null, 'Корень content-addressed реестра модулей-бандлов; дефолт вычисляется: apps/backtester/.data/bundles.'),
  flagVar('BACKTESTER_COALESCE_ENABLED', 'In-flight коалесцирование запросов (leader/follower); эффективен только вместе с BACKTESTER_DEDUP_ENABLED.'),
  envVar('BACKTESTER_COMPUTE_LOCK_TTL_MS', 'duration_ms', null, 'TTL compute-lock (мс); дефолт вычисляется = workerLeaseTtlMs.'),
  envVar('BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS', 'int', '3', 'Poison-cap попыток compute_wait.'),
  envVar('BACKTESTER_DATA_API_MAX_ATTEMPTS', 'int', '3', 'P2-12: всего попыток на data-API запрос, включая первую (1 = без ретраев). Fail-fast: конечное число >= 1.'),
  envVar('BACKTESTER_DATA_API_MAX_PAGES', 'int', '10000', 'P2-12: fail-closed cap страниц одного queryRange. Fail-fast: конечное число >= 1.'),
  envVar('BACKTESTER_DATA_API_MAX_ROWS', 'int', '5000000', 'P2-12: fail-closed cap строк одного queryRange (защита materialize). Fail-fast: конечное число >= 1.'),
  envVar('BACKTESTER_DATA_API_OPERATION_DEADLINE_MS', 'duration_ms', '0', 'P2-12: дедлайн всего queryRange через страницы+ретраи; 0 = выключен. Fail-fast: конечное число >= 0.'),
  envVar('BACKTESTER_DATA_API_PAGE_LIMIT', 'int', '1000', 'Лимит строк на страницу data-API.'),
  envVar('BACKTESTER_DATA_API_RETRY_BASE_MS', 'duration_ms', '500', 'P2-12: базовая задержка ретрая (full jitter, удвоение). Fail-fast: конечное число >= 1.'),
  envVar('BACKTESTER_DATA_API_RETRY_MAX_MS', 'duration_ms', '10000', 'P2-12: потолок бэккоффа ретрая; fail-fast: >= BACKTESTER_DATA_API_RETRY_BASE_MS.'),
  envVar('BACKTESTER_DATA_API_TIMEOUT_MS', 'duration_ms', '30000', 'P2-12: per-request таймаут HttpDataPort. Fail-fast: конечное число >= 1.'),
  envVar('BACKTESTER_DATA_API_TOKEN', 'string', null, 'Bearer-токен Research Historical Data API (НЕ биржевые креды).', { secret: true }),
  envVar('BACKTESTER_DATA_API_URL', 'url', null, 'Базовый URL Research Historical Data API; требуется при BACKTESTER_DATA_SOURCE=http.'),
  envVar('BACKTESTER_DATA_SOURCE', 'enum', 'fixture', 'Источник исторических данных: fixture (in-process), http (data-API), mock/real (rows-порт /historical/rows). Незнакомое значение тихо резолвится в fixture; real требует BACKTESTER_REAL_PLATFORM_URL/_TOKEN (fail-fast).', { enumValues: ['fixture', 'http', 'mock', 'real'] }),
  flagVar('BACKTESTER_DEDUP_ENABLED', 'Fingerprint-based result-dedup кэш (dark launch).'),
  envVar('BACKTESTER_DIAG_CONCENTRATION_PCT', 'float', '80', 'E1b: порог флага single_trade_dominated (% гросс-прибыли); 0 = максимальная чувствительность.'),
  envVar('BACKTESTER_DIAG_MIN_TRADES', 'int', '30', 'E1b: порог флага underpowered (трейдов); 0 = отключить флаг.'),
  flagVar('BACKTESTER_ENABLE_OVERLAY_ENGINE', 'Lifted overlay-путь движка (engine:overlay); OFF до зелёного verify_018 parity-гейта.'),
  envVar('BACKTESTER_FIXTURES_DIR', 'string', null, 'Каталог fixture-датасетов (<datasetRef>.json) для in-process data-порта; дефолт вычисляется: apps/backtester/fixtures/candles.'),
  flagVar('BACKTESTER_HOLDOUT_ENABLED', 'E4a: held-out OOS qualification marker (dark launch). При включении требует валидную BACKTESTER_HOLDOUT_FRACTION (fail-fast).'),
  envVar('BACKTESTER_HOLDOUT_FRACTION', 'float', '0.2', 'E4a: held-out окно = последняя доля coverage; читается только при BACKTESTER_HOLDOUT_ENABLED. Fail-fast при включённом holdout: конечное число в (0,1).'),
  envVar('BACKTESTER_HOST', 'string', '127.0.0.1', 'Bind-адрес HTTP API. Не-loopback требует явный BACKTESTER_AUTH_TOKEN (fail-fast, P2-10).'),
  envVar('BACKTESTER_IPC_PROFILE', 'bool', 'false', 'true = аккумулировать per-session IPC-профиль (open/wait тайминги), дамп на close(). Читается один раз при инициализации класса SandboxSession.', { consumers: ['apps/backtester/src/engine/sandbox/sandbox-session.ts'] }),
  flagVar('BACKTESTER_JOB_OBS', 'Per-job observability: терминальная лог-строка + /statsz.'),
  envVar('BACKTESTER_MOCK_PLATFORM_TOKEN', 'string', null, 'Bearer-токен trading-mock-platform (MOCK_OPS_TOKENS-verified).', { secret: true }),
  envVar('BACKTESTER_MOCK_PLATFORM_URL', 'url', null, 'Базовый URL trading-mock-platform; требуется при BACKTESTER_DATA_SOURCE=mock.'),
  envVar('BACKTESTER_NOVELTY_CORR_THRESHOLD', 'float', '0.8', 'E5a: behavioralDuplicate при maxAbsCorrelation >= порога. Fail-fast при включённом novelty: число в [0,1].'),
  flagVar('BACKTESTER_NOVELTY_ENABLED', 'E5a: behavioral-novelty gate (dark launch). При включении валидируются заданные пороги (fail-fast, NoveltyConfigError).'),
  envVar('BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS', 'int', '30', 'E5a: минимум общих UTC-дней для валидного Pearson. Fail-fast при включённом novelty: целое >= 1.'),
  envVar('BACKTESTER_PG_POOL_MAX', 'int', '10', 'Максимум pooled Pg-коннектов на процесс.'),
  envVar('BACKTESTER_PG_STATEMENT_TIMEOUT_MS', 'duration_ms', '0', 'statement_timeout на app-pool коннектах; 0 = выключен. Миграции исключены by construction.'),
  envVar('BACKTESTER_PORT', 'int', '8080', 'Порт HTTP API.'),
  flagVar('BACKTESTER_PROMOTION_HOLDOUT_GATE', 'E4b: promotion-enforcement gate (dark launch). Требует BACKTESTER_HOLDOUT_ENABLED=true и валидную фракцию (fail-fast).'),
  envVar('BACKTESTER_QUEUE_MAX_DEPTH', 'int', '0', 'Cap очереди: новый submit сверх — 429 queue_full; 0 = без лимита.'),
  flagVar('BACKTESTER_QUEUE_NOTIFY', 'Phase D item 16: LISTEN/NOTIFY-пробуждение очереди (Pg-store only; instanceof-гейт в worker-main).', 'off', { ownerUnit: WORKER }),
  envVar('BACKTESTER_QUEUE_RETRY_AFTER_S', 'int', '30', 'Retry-After (секунды) в 429-ответе.'),
  envVar('BACKTESTER_QUEUE_TIMEOUT_MS', 'duration_ms', '21600000', 'Дефолтный таймаут ожидания в очереди (6 ч).'),
  envVar('BACKTESTER_REAL_PLATFORM_TOKEN', 'string', null, 'Bearer-токен живой real-platform; обязателен при BACKTESTER_DATA_SOURCE=real (fail-fast).', { secret: true }),
  envVar('BACKTESTER_REAL_PLATFORM_URL', 'url', null, 'Базовый URL живой real-platform (start-historical-http); обязателен при BACKTESTER_DATA_SOURCE=real (fail-fast).'),
  envVar('BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS', 'duration_ms', null, 'P3-6b: каденс sweep result-кэша; дефолт вычисляется min(ttl, 60s). Fail-fast (при заданном TTL): положительное целое.'),
  envVar('BACKTESTER_RESULT_CACHE_TTL_MS', 'duration_ms', null, 'P3-6b: TTL строк result-кэша; не задан = TTL-eviction OFF. Fail-fast: положительное safe-целое.'),
  flagVar('BACKTESTER_RUN_DIAGNOSTICS', 'E1b: структурированная run-диагностика (dark launch).'),
  envVar('BACKTESTER_RUN_TIMEOUT_MS', 'duration_ms', '7200000', 'Дефолтный таймаут исполнения одного run (2 ч).'),
  envVar('BACKTESTER_S3_ACCESS_KEY', 'string', null, 'S3 access key; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast).', { secret: true }),
  envVar('BACKTESTER_S3_BUCKET', 'string', null, 'S3 bucket; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast).'),
  envVar('BACKTESTER_S3_ENDPOINT', 'url', null, 'S3-совместимый endpoint (MinIO first-class); обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast).'),
  envVar('BACKTESTER_S3_FORCE_PATH_STYLE', 'bool', 'true', 'Path-style адресация S3 (MinIO); false — для AWS virtual-hosted.'),
  envVar('BACKTESTER_S3_REGION', 'string', null, 'Опциональный S3-регион.'),
  envVar('BACKTESTER_S3_SECRET_KEY', 'string', null, 'S3 secret key; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast).', { secret: true }),
  envVar('BACKTESTER_SANDBOX_CPUS', 'float', '1', 'Slice-3 sandbox: лимит CPU контейнера.'),
  envVar('BACKTESTER_SANDBOX_HARNESS_DIR', 'string', null, 'Slice-3 sandbox: каталог доверенного in-container harness (:ro); дефолт вычисляется: apps/backtester/sandbox-harness.'),
  envVar('BACKTESTER_SANDBOX_IMAGE', 'string', 'node:24-alpine', 'Slice-3 sandbox: образ контейнера.'),
  envVar('BACKTESTER_SANDBOX_MEMORY_MB', 'int', '256', 'Slice-3 sandbox: лимит памяти (MiB).'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_CPUS', 'float', null, 'Overlay sandbox (Slice-6b-A): лимит CPU; дефолт — DEFAULT_SANDBOX.limits.cpus.'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR', 'string', null, 'Overlay sandbox: каталог overlay-harness; дефолт вычисляется: apps/backtester/sandbox-harness-overlay.'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_IMAGE', 'string', null, 'Overlay sandbox: пиннёный base-image digest; дефолт — лифтнутый SANDBOX_IMAGE (см. engine/sandbox-policy).'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB', 'int', null, 'Overlay sandbox: лимит памяти (MiB); дефолт — DEFAULT_SANDBOX.limits.memoryBytes.'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_PIDS', 'int', null, 'Overlay sandbox: pids-limit; дефолт — DEFAULT_SANDBOX.isolation.pidsLimit.'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_VOLUME', 'string', null, 'Overlay sandbox: shared named volume для DooD-доставки бандла/harness (demo). Задаётся строго парой с BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT (fail-fast на half-config); без пары — bind-режим (dev).'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT', 'string', null, 'Overlay sandbox: mountpoint volume на стороне backtester (например /sandbox-shared). Задаётся строго парой с BACKTESTER_SANDBOX_OVERLAY_VOLUME (fail-fast на half-config).'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_CALL', 'duration_ms', null, 'Overlay sandbox: wall-time лимит на hook-вызов; дефолт — DEFAULT_SANDBOX.limits.wallTimeMsPerCall.'),
  envVar('BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION', 'duration_ms', null, 'Overlay sandbox: wall-time лимит на сессию; дефолт — DEFAULT_SANDBOX.limits.wallTimeMsPerSession.'),
  envVar('BACKTESTER_SANDBOX_PIDS', 'int', '64', 'Slice-3 sandbox: pids-limit контейнера.'),
  envVar('BACKTESTER_SANDBOX_TMPFS_MB', 'int', '64', 'Slice-3 sandbox: размер tmpfs (MiB).'),
  envVar('BACKTESTER_SANDBOX_USER', 'string', '65534:65534', 'Slice-3 sandbox: uid:gid контейнера (nobody).'),
  envVar('BACKTESTER_SANDBOX_WALL_MS', 'duration_ms', '10000', 'Slice-3 sandbox: wall-time лимит (мс).'),
  envVar('BACKTESTER_STORE_BACKEND', 'enum', 'filesystem', 'Бэкенд object-store артефактов+бандлов. s3 требует BACKTESTER_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY (fail-fast); незнакомое значение — fail-fast.', { enumValues: ['filesystem', 's3'] }),
  envVar('BACKTESTER_TEST_DATABASE_URL', 'url', null, 'Тестовый Postgres (pg-gated suites; CI поднимает postgres:16-alpine). Fallback: DATABASE_URL.', { secret: true, ownerUnit: TESTS, consumers: ['apps/backtester/test/store-factories.ts'] }),
  envVar('BACKTESTER_TEST_DATA_API_TOKEN', 'string', null, 'Bearer-токен внешнего data-API для интеграционного прогона data-api.test.ts.', { secret: true, ownerUnit: TESTS, consumers: ['apps/backtester/test/data-api.test.ts'] }),
  envVar('BACKTESTER_TEST_DATA_API_URL', 'url', null, 'URL внешнего data-API: переключает data-api.test.ts в интеграционный режим против живого сервера.', { ownerUnit: TESTS, consumers: ['apps/backtester/test/data-api.test.ts'] }),
  envVar('BACKTESTER_TRIAL_EMPIRICAL_MIN_N', 'int', '5', 'E2: N, с которого V[SR] переключается asymptotic→empirical (клампится к >= 2).'),
  flagVar('BACKTESTER_TRIAL_LEDGER', 'E2: trial ledger + advisory Deflated Sharpe. Default ON (#156, research-validation-hardening item 1; fail-open-in-advisory) — выключается только явным false.', 'enforce'),
  envVar('BACKTESTER_UNIVERSE_MAX_N', 'int', '64', '17c: отклонять universe-run с числом символов сверх лимита (pre-exec валидация).'),
  envVar('BACKTESTER_UNIVERSE_MEM_BASE_MB', 'int', '128', '17c: базовый memory-floor контейнера (MiB) для universe-режима.'),
  envVar('BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB', 'int', '8', '17c: память на символ (MiB) поверх базы для universe-контейнера.'),
  flagVar('BACKTESTER_UNIVERSE_SESSION', '17c: все символы бандла в ОДНОМ контейнере (N per-symbol инстансов; dark launch).'),
  flagVar('BACKTESTER_WALK_FORWARD_ENABLED', 'E3b: walk-forward per-fold исполнение (dark launch, PR #121).'),
  envVar('BACKTESTER_WALK_FORWARD_MAX_FOLDS', 'int', '20', 'E3b: policy-cap числа фолдов (safe-целое >= 1; мусор → 20).'),
  envVar('BENCH_API_PORT', 'int', '18080', 'bench-workers: порт API-ноды бенча.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BENCH_CONC', 'csv', '1,2,4', 'bench-workers: список степеней конкурентности прогона (через запятую).', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BENCH_MODE', 'enum', 'momentum', 'bench-workers: режим бенча (незнакомое значение НЕ валидируется — приводится as-cast).', { enumValues: ['momentum', 'sandbox'], ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BENCH_N', 'int', null, 'Bench: число submit; дефолт зависит от потребителя (6 в bench-parallel-drain, клампится к >= 2; 120/12 по режиму в bench-workers).', { ownerUnit: TESTS, consumers: ['apps/backtester/test/bench-parallel-drain.test.ts', 'apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BENCH_PG_PORT', 'int', '55432', 'bench-workers: порт одноразового Postgres бенча.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BENCH_SESSION_BUDGET_MS', 'duration_ms', '600000', 'bench-workers: wall-time бюджет sandbox-сессии (sub#4 knob).', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/bench-workers.mts'] }),
  envVar('BT_EVIDENCE_SIGNING_KEY', 'string', null, 'PEM PKCS8 Ed25519 приватный ключ подписи backtest-evidence. Не задан = подпись OFF (эфемерные ключи не генерируются — keyId должен быть в allowlist платформы).', { secret: true, consumers: [CONFIG, 'apps/backtester/scripts/export-signer-pubkey.mts', 'apps/backtester/scripts/produce-evidence.mts', 'apps/backtester/scripts/produce-long-oi-evidence.mts'] }),
  envVar('DATABASE_URL', 'url', null, 'Postgres connection string: задан — PgJobStore, нет — in-memory. worker-main требует его (fail-fast в entrypoint).', { secret: true, consumers: [CONFIG, 'apps/backtester/test/store-factories.ts'] }),
  envVar('DATA_API_FIXTURES_DIR', 'string', null, 'Референс data-api: каталог fixture-датасетов; дефолт вычисляется: apps/backtester/fixtures/candles.', { ownerUnit: DATA_API, consumers: ['apps/backtester/src/data-api-main.ts'] }),
  envVar('DATA_API_HOST', 'string', '127.0.0.1', 'Референс data-api: bind-адрес.', { ownerUnit: DATA_API, consumers: ['apps/backtester/src/data-api-main.ts'] }),
  envVar('DATA_API_PORT', 'int', '8081', 'Референс data-api: порт.', { ownerUnit: DATA_API, consumers: ['apps/backtester/src/data-api-main.ts'] }),
  envVar('DATA_API_TOKEN', 'string', null, 'Референс data-api: bearer-токен; не задан = auth выключен (dev-инструмент).', { secret: true, ownerUnit: DATA_API, consumers: ['apps/backtester/src/data-api-main.ts'] }),
  envVar('LONGOI_BUNDLE', 'string', null, 'produce-long-oi-evidence: путь к long-oi бандлу; дефолт вычисляется (локальный путь разработчика).', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/produce-long-oi-evidence.mts'] }),
  envVar('LONGOI_BUNDLE_HASH', 'string', 'sha256:38fe5286dd8152da7a74e043576b2a9333ec23950839cb25289881bfe2c4416c', 'produce-long-oi-evidence: ожидаемый hash бандла (integrity-пин).', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/produce-long-oi-evidence.mts'] }),
  envVar('LONGOI_DIAG', 'string', null, 'produce-long-oi-evidence: значение 1 включает диагностический вывод.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/produce-long-oi-evidence.mts'] }),
  envVar('LONGOI_SNAPSHOT', 'string', null, 'produce-long-oi-evidence: путь к snapshot-файлу датасета.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/produce-long-oi-evidence.mts'] }),
  envVar('PLATFORM_REPO', 'string', null, 'Путь к чекауту trading-platform для cross-repo/evidence/golden-sync тестов; дефолт вычисляется (локальный путь разработчика), без чекаута тесты скипаются.', { ownerUnit: TESTS, consumers: ['apps/backtester/test/cross-repo-historical-e2e.integration.test.ts', 'apps/backtester/test/evidence-conformance.test.ts', 'apps/backtester/test/evidence-harness.test.ts', 'apps/backtester/test/golden-sync.test.ts'] }),
  envVar('PNL_TOL', 'float', '0.0001', 'validate-execution: допуск сверки PnL с эталоном.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/validate-execution.mts'] }),
  envVar('RUN_BENCH', 'string', null, 'Значение 1 включает bench-parallel-drain (иначе skip).', { ownerUnit: TESTS, consumers: ['apps/backtester/test/bench-parallel-drain.test.ts'] }),
  envVar('RUN_CROSS_REPO_E2E', 'bool', 'false', 'true включает opt-in cross-repo historical E2E (детерминизм-гейт против реального platform-чекаута).', { ownerUnit: TESTS, consumers: ['apps/backtester/test/cross-repo-historical-e2e.integration.test.ts'] }),
  envVar('SLICE_PATH', 'string', null, 'Скрипты фикстур/валидации: путь к slice-файлу исторических данных; дефолт вычисляется per-скрипт.', { ownerUnit: DEVTOOLS, consumers: ['apps/backtester/scripts/extract-signal-parity-fixture.mts', 'apps/backtester/scripts/extract-validation-fixture.mts', 'apps/backtester/scripts/validate-execution.mts'] }),
  envVar('TAPE_CACHE_MAX_ENTRIES', 'int', '16', 'Ёмкость LRU tape-кэша воркера; 0 = выключить кэш; мусор → 16. Читается при создании синглтонов.', { consumers: ['apps/backtester/src/data/tape-cache.ts'] }),
  envVar('WORKER_CONCURRENCY', 'int', '4', 'Максимум одновременных backtest-ранов in-process worker-пула (клампится к >= 1; 1 = serial).', { ownerUnit: WORKER }),
  envVar('WORKER_ERROR_BACKOFF_BASE_MS', 'duration_ms', '500', 'P2-7: первый бэккофф после ошибки итерации worker-loop (клампится к >= 50; удваивается).', { ownerUnit: WORKER }),
  envVar('WORKER_ERROR_BACKOFF_MAX_MS', 'duration_ms', '30000', 'P2-7: потолок бэккоффа worker-loop (клампится к >= base).', { ownerUnit: WORKER }),
  envVar('WORKER_HEALTH_PORT', 'int', null, 'TCP-порт health-сервера воркера (/healthz + /readyz); не задан = сервер не поднимается.', { ownerUnit: WORKER }),
  envVar('WORKER_HEARTBEAT_MS', 'duration_ms', '10000', 'Интервал heartbeat: воркеры продлевают in-flight lease (клампится к >= 1000).', { ownerUnit: WORKER }),
  envVar('WORKER_ID', 'string', null, 'Стабильный id worker-процесса (владелец lease); дефолт вычисляется: hostname:pid.', { ownerUnit: WORKER }),
  envVar('WORKER_LEASE_TTL_MS', 'duration_ms', '30000', 'Lease TTL при claim (клампится к >= 3 * heartbeat; см. P3-5 guidance в config.ts).', { ownerUnit: WORKER }),
  envVar('WORKER_MAX_ATTEMPTS', 'int', '3', 'Максимум claim-попыток до пометки повторно-осиротевшего job как poison.', { ownerUnit: WORKER }),
  envVar('WORKER_POLL_MS', 'duration_ms', '500', 'Интервал idle-опроса пустой очереди (клампится к >= 50).', { ownerUnit: WORKER }),
];

// ---------------------------------------------------------------------------
// Единственная точка доступа к process.env.
// ---------------------------------------------------------------------------

/** Живая ссылка на process.env — дефолтный источник loadConfig/loadEnv. */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** Живое чтение одной переменной (для ленивых call-time чтений: tape-cache, sandbox-session, data-api). */
export function readEnvVar(name: string): string | undefined {
  return process.env[name];
}

/** P2-10: host loopback-only (безопасен с dev-дефолтным токеном) — 127.0.0.0/8, ::1, localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1') return true; // единственные доверенные hostname / IPv6-литерал
  // 127.0.0.0/8 — только как настоящий IPv4-литерал: hostname вида "127.attacker.internal"
  // лишь начинается с "127.", но может резолвиться во внешний интерфейс.
  if (isIP(h) === 4) return Number(h.split('.')[0]) === 127;
  return false;
}

// ---------------------------------------------------------------------------
// Fail-fast валидация (zod). Зеркало существующих fail-fast проверок loadConfig —
// accept-set идентичен (пины: test/env-schema.test.ts, паритет-кейсы), но ошибки
// агрегируются ВСЕ разом, а не первая.
// ---------------------------------------------------------------------------

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid environment (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Все нарушения fail-fast инвариантов env (зеркало loadConfig; пусто = валидно). */
function collectEnvIssues(env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];

  // P2-12: posInt / nonNegInt группа HttpDataPort.
  const posIntNames = [
    'BACKTESTER_DATA_API_TIMEOUT_MS',
    'BACKTESTER_DATA_API_MAX_ATTEMPTS',
    'BACKTESTER_DATA_API_RETRY_BASE_MS',
    'BACKTESTER_DATA_API_RETRY_MAX_MS',
    'BACKTESTER_DATA_API_MAX_PAGES',
    'BACKTESTER_DATA_API_MAX_ROWS',
  ] as const;
  for (const name of posIntNames) {
    const raw = env[name];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) issues.push(`${name} must be a finite number >= 1 (got ${String(raw)})`);
  }
  {
    const raw = env.BACKTESTER_DATA_API_OPERATION_DEADLINE_MS;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        issues.push(`BACKTESTER_DATA_API_OPERATION_DEADLINE_MS must be a finite number >= 0 (got ${String(raw)})`);
      }
    }
  }
  {
    const base = env.BACKTESTER_DATA_API_RETRY_BASE_MS === undefined ? 500 : Number(env.BACKTESTER_DATA_API_RETRY_BASE_MS);
    const max = env.BACKTESTER_DATA_API_RETRY_MAX_MS === undefined ? 10_000 : Number(env.BACKTESTER_DATA_API_RETRY_MAX_MS);
    if (Number.isFinite(base) && base >= 1 && Number.isFinite(max) && max >= 1 && Math.floor(max) < Math.floor(base)) {
      issues.push(`BACKTESTER_DATA_API_RETRY_MAX_MS (${Math.floor(max)}) must be >= BACKTESTER_DATA_API_RETRY_BASE_MS (${Math.floor(base)})`);
    }
  }

  // Store backend + обязательный s3-набор.
  const sb = env.BACKTESTER_STORE_BACKEND;
  if (sb && sb !== 'filesystem' && sb !== 's3') {
    issues.push(`invalid BACKTESTER_STORE_BACKEND '${sb}' (expected 'filesystem' or 's3')`);
  }
  if (sb === 's3') {
    for (const name of ['BACKTESTER_S3_ENDPOINT', 'BACKTESTER_S3_BUCKET', 'BACKTESTER_S3_ACCESS_KEY', 'BACKTESTER_S3_SECRET_KEY'] as const) {
      if (!env[name]) issues.push(`${name} is required when BACKTESTER_STORE_BACKEND=s3`);
    }
  }

  // dataSource=real ⇒ пара URL/TOKEN.
  if (env.BACKTESTER_DATA_SOURCE === 'real') {
    if (!env.BACKTESTER_REAL_PLATFORM_URL?.trim() || !env.BACKTESTER_REAL_PLATFORM_TOKEN?.trim()) {
      issues.push('BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real');
    }
  }

  // P2-10: не-loopback bind требует явный токен.
  const host = env.BACKTESTER_HOST ?? '127.0.0.1';
  const authTokenSet = typeof env.BACKTESTER_AUTH_TOKEN === 'string' && env.BACKTESTER_AUTH_TOKEN.trim().length > 0;
  if (!authTokenSet && !isLoopbackHost(host)) {
    issues.push(`BACKTESTER_AUTH_TOKEN is required when BACKTESTER_HOST (${host}) is not a loopback address`);
  }

  // Взаимоисключение bar-major / bar-batching.
  if (env.BACKTESTER_BAR_MAJOR === 'true' && env.BACKTESTER_BAR_BATCHING === 'true') {
    issues.push('BACKTESTER_BAR_MAJOR and BACKTESTER_BAR_BATCHING cannot both be enabled');
  }

  // E4a: holdout ⇒ валидная фракция.
  const holdoutFractionValid = (): boolean => {
    const f = Number(env.BACKTESTER_HOLDOUT_FRACTION);
    return Number.isFinite(f) && f > 0 && f < 1;
  };
  if (env.BACKTESTER_HOLDOUT_ENABLED === 'true' && !holdoutFractionValid()) {
    issues.push('BACKTESTER_HOLDOUT_FRACTION must be a finite number in (0,1) when BACKTESTER_HOLDOUT_ENABLED');
  }

  // E4b: promotion gate ⇒ holdout включён и фракция валидна.
  if (env.BACKTESTER_PROMOTION_HOLDOUT_GATE === 'true') {
    if (env.BACKTESTER_HOLDOUT_ENABLED !== 'true') {
      issues.push('BACKTESTER_PROMOTION_HOLDOUT_GATE requires BACKTESTER_HOLDOUT_ENABLED=true');
    } else if (!holdoutFractionValid()) {
      issues.push('BACKTESTER_PROMOTION_HOLDOUT_GATE requires a valid BACKTESTER_HOLDOUT_FRACTION in (0,1)');
    }
  }

  // E5a: пороги novelty валидируются только при включённом гейте и только заданные.
  if (env.BACKTESTER_NOVELTY_ENABLED === 'true') {
    if (env.BACKTESTER_NOVELTY_CORR_THRESHOLD !== undefined) {
      const t = Number(env.BACKTESTER_NOVELTY_CORR_THRESHOLD);
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        issues.push('BACKTESTER_NOVELTY_CORR_THRESHOLD must be a number in [0,1] when BACKTESTER_NOVELTY_ENABLED');
      }
    }
    if (env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS !== undefined) {
      const d = Number(env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS);
      if (!Number.isInteger(d) || d < 1) {
        issues.push('BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS must be an integer >= 1 when BACKTESTER_NOVELTY_ENABLED');
      }
    }
  }

  // P3-6b: TTL-eviction result-кэша; sweep валидируется только при заданном TTL (зеркало ветки loadConfig).
  const rawTtl = env.BACKTESTER_RESULT_CACHE_TTL_MS;
  if (rawTtl !== undefined && rawTtl.trim() !== '') {
    const n = Number(rawTtl);
    if (!Number.isSafeInteger(n) || n <= 0) {
      issues.push(`BACKTESTER_RESULT_CACHE_TTL_MS must be a positive integer (ms), got "${rawTtl}"`);
    }
    const rawInterval = env.BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS;
    if (rawInterval !== undefined && rawInterval.trim() !== '') {
      const iv = Number(rawInterval);
      if (!Number.isSafeInteger(iv) || iv <= 0) {
        issues.push(`BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS must be a positive integer (ms), got "${rawInterval}"`);
      }
    }
  }

  // Overlay volume: строго пара (зеркало mountConfigFor).
  if ((env.BACKTESTER_SANDBOX_OVERLAY_VOLUME === undefined) !== (env.BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT === undefined)) {
    issues.push('set both BACKTESTER_SANDBOX_OVERLAY_VOLUME and BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT, or neither');
  }

  return issues;
}

const rawEnvSchema = z
  .record(z.string(), z.string().optional())
  .superRefine((env, ctx) => {
    for (const message of collectEnvIssues(env as NodeJS.ProcessEnv)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

/**
 * Fail-fast валидация env: safeParse (все ошибки разом) + иммутабельный снапшот.
 * Вызывается из entrypoint-ов (index.ts, worker-main.ts) ДО loadConfig; отклоняет ровно те env,
 * которые отклонил бы loadConfig (паритет пинуют тесты), но перечисляет все нарушения сразу.
 */
export function loadEnv(env: NodeJS.ProcessEnv = processEnv()): Readonly<Record<string, string | undefined>> {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map((i) => i.message));
  }
  return Object.freeze({ ...env });
}

// ---------------------------------------------------------------------------
// Экспорт документа env-schema.1 (детерминированный: одинаковый env.ts ⇒ байт-в-байт JSON).
// ---------------------------------------------------------------------------

export function envSchemaDocument(): EnvSchemaDocument {
  const variables = [...ENV_VARS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((v): EnvSchemaVariable => ({
      name: v.name,
      type: v.type,
      required: v.required,
      default: v.default,
      description: v.description,
      secret: v.secret,
      flag: v.flag,
      ...(v.enumValues ? { enum_values: [...v.enumValues] } : {}),
      ...(v.flagStates ? { flag_states: [...v.flagStates] } : {}),
      ...(v.defaultState ? { default_state: v.defaultState } : {}),
      owner_unit: v.ownerUnit,
      consumers: [...v.consumers],
    }));
  return {
    schema_version: ENV_SCHEMA_VERSION,
    repo: REPO_ID,
    generated_from: GENERATED_FROM,
    variables,
  };
}

/** Точный stdout-формат `npm run env:schema`: JSON, 2 пробела, завершающий '\n'. */
export function renderEnvSchemaJson(): string {
  return JSON.stringify(envSchemaDocument(), null, 2) + '\n';
}
