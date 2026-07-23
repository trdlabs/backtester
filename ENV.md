<!-- GENERATED FILE — не редактировать руками. Источник: apps/backtester/src/env.ts;
     перегенерация: npm run env:docs. Контракт: control-center docs/architecture/contracts/env-schema.md -->

# Environment variables — trading-backtester

Схема: `apps/backtester/src/env.ts` (контракт `env-schema.1`). Машинный экспорт: `npm run env:schema`.

Секреты: в таблице и example-файлах — только имя и форма, значения живут в SOPS/age-контуре
(b2c-ops-hardening item 3). Флаги — деплой-таймовые E4b-паттерна; `default` у флага в схеме
пуст, фактическое состояние без переменной несёт `default_state` (`off` = выключен,
`enforce` = включён).

| Name | Type | Required | Default | Secret | Flag | Owner unit | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BACKTESTER_ARTIFACTS_DIR` | string | no | — |  |  | backtester-service | Корень content-addressed стора артефактов; дефолт вычисляется: apps/backtester/.data/artifacts. |
| `BACKTESTER_AUTH_TOKEN` | string | no | — | yes |  | backtester-service | Bearer-токен /v1 API (fail-closed). На loopback допустим dev-дефолт; на не-loopback BACKTESTER_HOST обязателен (fail-fast, P2-10). |
| `BACKTESTER_AUTO_WORKER` | bool | no | `true` |  |  | backtester-service | HTTP-нода запускает фоновый worker-tick; false — только API (multi-process с worker-main). |
| `BACKTESTER_BAR_BATCHING` | bool | no | — |  | flag: off/enforce, default off | backtester-service | 17b: батчинг flat-stretch onBarClose в одно sandbox-сообщение (dark launch). Взаимоисключим с BACKTESTER_BAR_MAJOR (fail-fast). |
| `BACKTESTER_BAR_MAJOR` | bool | no | — |  | flag: off/enforce, default off | backtester-service | 17d: bar-major исполнение — один бар по всем символам до продвижения (dark launch). Взаимоисключим с BACKTESTER_BAR_BATCHING (fail-fast). |
| `BACKTESTER_BAR_MAJOR_BATCH` | bool | no | — |  | flag: off/enforce, default off | backtester-service | Slice B: 3-фазный батч-транспорт per-bar IPC bar-major; чистый суб-режим BACKTESTER_BAR_MAJOR (инертен без него). |
| `BACKTESTER_BATCH_BARS` | int | no | `64` |  |  | backtester-service | 17b: максимум баров на hookBatch (клампится к >= 2; мусор → 64). |
| `BACKTESTER_BUNDLES_DIR` | string | no | — |  |  | backtester-service | Корень content-addressed реестра модулей-бандлов; дефолт вычисляется: apps/backtester/.data/bundles. |
| `BACKTESTER_COALESCE_ENABLED` | bool | no | — |  | flag: off/enforce, default off | backtester-service | In-flight коалесцирование запросов (leader/follower); эффективен только вместе с BACKTESTER_DEDUP_ENABLED. |
| `BACKTESTER_COMPUTE_LOCK_TTL_MS` | duration_ms | no | — |  |  | backtester-service | TTL compute-lock (мс); дефолт вычисляется = workerLeaseTtlMs. |
| `BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS` | int | no | `3` |  |  | backtester-service | Poison-cap попыток compute_wait. |
| `BACKTESTER_DATA_API_MAX_ATTEMPTS` | int | no | `3` |  |  | backtester-service | P2-12: всего попыток на data-API запрос, включая первую (1 = без ретраев). Fail-fast: конечное число >= 1. |
| `BACKTESTER_DATA_API_MAX_PAGES` | int | no | `10000` |  |  | backtester-service | P2-12: fail-closed cap страниц одного queryRange. Fail-fast: конечное число >= 1. |
| `BACKTESTER_DATA_API_MAX_ROWS` | int | no | `5000000` |  |  | backtester-service | P2-12: fail-closed cap строк одного queryRange (защита materialize). Fail-fast: конечное число >= 1. |
| `BACKTESTER_DATA_API_OPERATION_DEADLINE_MS` | duration_ms | no | `0` |  |  | backtester-service | P2-12: дедлайн всего queryRange через страницы+ретраи; 0 = выключен. Fail-fast: конечное число >= 0. |
| `BACKTESTER_DATA_API_PAGE_LIMIT` | int | no | `1000` |  |  | backtester-service | Лимит строк на страницу data-API. |
| `BACKTESTER_DATA_API_RETRY_BASE_MS` | duration_ms | no | `500` |  |  | backtester-service | P2-12: базовая задержка ретрая (full jitter, удвоение). Fail-fast: конечное число >= 1. |
| `BACKTESTER_DATA_API_RETRY_MAX_MS` | duration_ms | no | `10000` |  |  | backtester-service | P2-12: потолок бэккоффа ретрая; fail-fast: >= BACKTESTER_DATA_API_RETRY_BASE_MS. |
| `BACKTESTER_DATA_API_TIMEOUT_MS` | duration_ms | no | `30000` |  |  | backtester-service | P2-12: per-request таймаут HttpDataPort. Fail-fast: конечное число >= 1. |
| `BACKTESTER_DATA_API_TOKEN` | string | no | — | yes |  | backtester-service | Bearer-токен Research Historical Data API (НЕ биржевые креды). |
| `BACKTESTER_DATA_API_URL` | url | no | — |  |  | backtester-service | Базовый URL Research Historical Data API; требуется при BACKTESTER_DATA_SOURCE=http. |
| `BACKTESTER_DATA_SOURCE` | enum(fixture, http, mock, real) | no | `fixture` |  |  | backtester-service | Источник исторических данных: fixture (in-process), http (data-API), mock/real (rows-порт /historical/rows). Незнакомое значение тихо резолвится в fixture; real требует BACKTESTER_REAL_PLATFORM_URL/_TOKEN (fail-fast). |
| `BACKTESTER_DEDUP_ENABLED` | bool | no | — |  | flag: off/enforce, default off | backtester-service | Fingerprint-based result-dedup кэш (dark launch). |
| `BACKTESTER_DIAG_CONCENTRATION_PCT` | float | no | `80` |  |  | backtester-service | E1b: порог флага single_trade_dominated (% гросс-прибыли); 0 = максимальная чувствительность. |
| `BACKTESTER_DIAG_MIN_TRADES` | int | no | `30` |  |  | backtester-service | E1b: порог флага underpowered (трейдов); 0 = отключить флаг. |
| `BACKTESTER_ENABLE_OVERLAY_ENGINE` | bool | no | — |  | flag: off/enforce, default off | backtester-service | Lifted overlay-путь движка (engine:overlay); OFF до зелёного verify_018 parity-гейта. |
| `BACKTESTER_FIXTURES_DIR` | string | no | — |  |  | backtester-service | Каталог fixture-датасетов (<datasetRef>.json) для in-process data-порта; дефолт вычисляется: apps/backtester/fixtures/candles. |
| `BACKTESTER_HOLDOUT_ENABLED` | bool | no | — |  | flag: off/enforce, default off | backtester-service | E4a: held-out OOS qualification marker (dark launch). При включении требует валидную BACKTESTER_HOLDOUT_FRACTION (fail-fast). |
| `BACKTESTER_HOLDOUT_FRACTION` | float | no | `0.2` |  |  | backtester-service | E4a: held-out окно = последняя доля coverage; читается только при BACKTESTER_HOLDOUT_ENABLED. Fail-fast при включённом holdout: конечное число в (0,1). |
| `BACKTESTER_HOST` | string | no | `127.0.0.1` |  |  | backtester-service | Bind-адрес HTTP API. Не-loopback требует явный BACKTESTER_AUTH_TOKEN (fail-fast, P2-10). |
| `BACKTESTER_IPC_PROFILE` | bool | no | `false` |  |  | backtester-service | true = аккумулировать per-session IPC-профиль (open/wait тайминги), дамп на close(). Читается один раз при инициализации класса SandboxSession. |
| `BACKTESTER_JOB_OBS` | bool | no | — |  | flag: off/enforce, default off | backtester-service | Per-job observability: терминальная лог-строка + /statsz. |
| `BACKTESTER_MOCK_PLATFORM_TOKEN` | string | no | — | yes |  | backtester-service | Bearer-токен trading-mock-platform (MOCK_OPS_TOKENS-verified). |
| `BACKTESTER_MOCK_PLATFORM_URL` | url | no | — |  |  | backtester-service | Базовый URL trading-mock-platform; требуется при BACKTESTER_DATA_SOURCE=mock. |
| `BACKTESTER_NOVELTY_CORR_THRESHOLD` | float | no | `0.8` |  |  | backtester-service | E5a: behavioralDuplicate при maxAbsCorrelation >= порога. Fail-fast при включённом novelty: число в [0,1]. |
| `BACKTESTER_NOVELTY_ENABLED` | bool | no | — |  | flag: off/enforce, default off | backtester-service | E5a: behavioral-novelty gate (dark launch). При включении валидируются заданные пороги (fail-fast, NoveltyConfigError). |
| `BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS` | int | no | `30` |  |  | backtester-service | E5a: минимум общих UTC-дней для валидного Pearson. Fail-fast при включённом novelty: целое >= 1. |
| `BACKTESTER_PG_POOL_MAX` | int | no | `10` |  |  | backtester-service | Максимум pooled Pg-коннектов на процесс. |
| `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` | duration_ms | no | `0` |  |  | backtester-service | statement_timeout на app-pool коннектах; 0 = выключен. Миграции исключены by construction. |
| `BACKTESTER_PORT` | int | no | `8080` |  |  | backtester-service | Порт HTTP API. |
| `BACKTESTER_PROMOTION_HOLDOUT_GATE` | bool | no | — |  | flag: off/enforce, default off | backtester-service | E4b: promotion-enforcement gate (dark launch). Требует BACKTESTER_HOLDOUT_ENABLED=true и валидную фракцию (fail-fast). |
| `BACKTESTER_QUEUE_MAX_DEPTH` | int | no | `0` |  |  | backtester-service | Cap очереди: новый submit сверх — 429 queue_full; 0 = без лимита. |
| `BACKTESTER_QUEUE_NOTIFY` | bool | no | — |  | flag: off/enforce, default off | backtester-worker | Phase D item 16: LISTEN/NOTIFY-пробуждение очереди (Pg-store only; instanceof-гейт в worker-main). |
| `BACKTESTER_QUEUE_RETRY_AFTER_S` | int | no | `30` |  |  | backtester-service | Retry-After (секунды) в 429-ответе. |
| `BACKTESTER_QUEUE_TIMEOUT_MS` | duration_ms | no | `21600000` |  |  | backtester-service | Дефолтный таймаут ожидания в очереди (6 ч). |
| `BACKTESTER_REAL_PLATFORM_TOKEN` | string | no | — | yes |  | backtester-service | Bearer-токен живой real-platform; обязателен при BACKTESTER_DATA_SOURCE=real (fail-fast). |
| `BACKTESTER_REAL_PLATFORM_URL` | url | no | — |  |  | backtester-service | Базовый URL живой real-platform (start-historical-http); обязателен при BACKTESTER_DATA_SOURCE=real (fail-fast). |
| `BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS` | duration_ms | no | — |  |  | backtester-service | P3-6b: каденс sweep result-кэша; дефолт вычисляется min(ttl, 60s). Fail-fast (при заданном TTL): положительное целое. |
| `BACKTESTER_RESULT_CACHE_TTL_MS` | duration_ms | no | — |  |  | backtester-service | P3-6b: TTL строк result-кэша; не задан = TTL-eviction OFF. Fail-fast: положительное safe-целое. |
| `BACKTESTER_RUN_DIAGNOSTICS` | bool | no | — |  | flag: off/enforce, default off | backtester-service | E1b: структурированная run-диагностика (dark launch). |
| `BACKTESTER_RUN_TIMEOUT_MS` | duration_ms | no | `7200000` |  |  | backtester-service | Дефолтный таймаут исполнения одного run (2 ч). |
| `BACKTESTER_S3_ACCESS_KEY` | string | no | — | yes |  | backtester-service | S3 access key; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast). |
| `BACKTESTER_S3_BUCKET` | string | no | — |  |  | backtester-service | S3 bucket; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast). |
| `BACKTESTER_S3_ENDPOINT` | url | no | — |  |  | backtester-service | S3-совместимый endpoint (MinIO first-class); обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast). |
| `BACKTESTER_S3_FORCE_PATH_STYLE` | bool | no | `true` |  |  | backtester-service | Path-style адресация S3 (MinIO); false — для AWS virtual-hosted. |
| `BACKTESTER_S3_REGION` | string | no | — |  |  | backtester-service | Опциональный S3-регион. |
| `BACKTESTER_S3_SECRET_KEY` | string | no | — | yes |  | backtester-service | S3 secret key; обязателен при BACKTESTER_STORE_BACKEND=s3 (fail-fast). |
| `BACKTESTER_SANDBOX_CPUS` | float | no | `1` |  |  | backtester-service | Slice-3 sandbox: лимит CPU контейнера. |
| `BACKTESTER_SANDBOX_HARNESS_DIR` | string | no | — |  |  | backtester-service | Slice-3 sandbox: каталог доверенного in-container harness (:ro); дефолт вычисляется: apps/backtester/sandbox-harness. |
| `BACKTESTER_SANDBOX_IMAGE` | string | no | `node:24-alpine` |  |  | backtester-service | Slice-3 sandbox: образ контейнера. |
| `BACKTESTER_SANDBOX_MEMORY_MB` | int | no | `256` |  |  | backtester-service | Slice-3 sandbox: лимит памяти (MiB). |
| `BACKTESTER_SANDBOX_OVERLAY_CPUS` | float | no | — |  |  | backtester-service | Overlay sandbox (Slice-6b-A): лимит CPU; дефолт — DEFAULT_SANDBOX.limits.cpus. |
| `BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR` | string | no | — |  |  | backtester-service | Overlay sandbox: каталог overlay-harness; дефолт вычисляется: apps/backtester/sandbox-harness-overlay. |
| `BACKTESTER_SANDBOX_OVERLAY_IMAGE` | string | no | — |  |  | backtester-service | Overlay sandbox: пиннёный base-image digest; дефолт — лифтнутый SANDBOX_IMAGE (см. engine/sandbox-policy). |
| `BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB` | int | no | — |  |  | backtester-service | Overlay sandbox: лимит памяти (MiB); дефолт — DEFAULT_SANDBOX.limits.memoryBytes. |
| `BACKTESTER_SANDBOX_OVERLAY_PIDS` | int | no | — |  |  | backtester-service | Overlay sandbox: pids-limit; дефолт — DEFAULT_SANDBOX.isolation.pidsLimit. |
| `BACKTESTER_SANDBOX_OVERLAY_VOLUME` | string | no | — |  |  | backtester-service | Overlay sandbox: shared named volume для DooD-доставки бандла/harness (demo). Задаётся строго парой с BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT (fail-fast на half-config); без пары — bind-режим (dev). |
| `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT` | string | no | — |  |  | backtester-service | Overlay sandbox: mountpoint volume на стороне backtester (например /sandbox-shared). Задаётся строго парой с BACKTESTER_SANDBOX_OVERLAY_VOLUME (fail-fast на half-config). |
| `BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_CALL` | duration_ms | no | — |  |  | backtester-service | Overlay sandbox: wall-time лимит на hook-вызов; дефолт — DEFAULT_SANDBOX.limits.wallTimeMsPerCall. |
| `BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION` | duration_ms | no | — |  |  | backtester-service | Overlay sandbox: wall-time лимит на сессию; дефолт — DEFAULT_SANDBOX.limits.wallTimeMsPerSession. |
| `BACKTESTER_SANDBOX_PIDS` | int | no | `64` |  |  | backtester-service | Slice-3 sandbox: pids-limit контейнера. |
| `BACKTESTER_SANDBOX_TMPFS_MB` | int | no | `64` |  |  | backtester-service | Slice-3 sandbox: размер tmpfs (MiB). |
| `BACKTESTER_SANDBOX_USER` | string | no | `65534:65534` |  |  | backtester-service | Slice-3 sandbox: uid:gid контейнера (nobody). |
| `BACKTESTER_SANDBOX_WALL_MS` | duration_ms | no | `10000` |  |  | backtester-service | Slice-3 sandbox: wall-time лимит (мс). |
| `BACKTESTER_STORE_BACKEND` | enum(filesystem, s3) | no | `filesystem` |  |  | backtester-service | Бэкенд object-store артефактов+бандлов. s3 требует BACKTESTER_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY (fail-fast); незнакомое значение — fail-fast. |
| `BACKTESTER_TEST_DATABASE_URL` | url | no | — | yes |  | backtester-tests | Тестовый Postgres (pg-gated suites; CI поднимает postgres:16-alpine). Fallback: DATABASE_URL. |
| `BACKTESTER_TEST_DATA_API_TOKEN` | string | no | — | yes |  | backtester-tests | Bearer-токен внешнего data-API для интеграционного прогона data-api.test.ts. |
| `BACKTESTER_TEST_DATA_API_URL` | url | no | — |  |  | backtester-tests | URL внешнего data-API: переключает data-api.test.ts в интеграционный режим против живого сервера. |
| `BACKTESTER_TRIAL_EMPIRICAL_MIN_N` | int | no | `5` |  |  | backtester-service | E2: N, с которого V[SR] переключается asymptotic→empirical (клампится к >= 2). |
| `BACKTESTER_TRIAL_LEDGER` | bool | no | — |  | flag: off/enforce, default enforce | backtester-service | E2: trial ledger + advisory Deflated Sharpe. Default ON (#156, research-validation-hardening item 1; fail-open-in-advisory) — выключается только явным false. |
| `BACKTESTER_UNIVERSE_MAX_N` | int | no | `64` |  |  | backtester-service | 17c: отклонять universe-run с числом символов сверх лимита (pre-exec валидация). |
| `BACKTESTER_UNIVERSE_MEM_BASE_MB` | int | no | `128` |  |  | backtester-service | 17c: базовый memory-floor контейнера (MiB) для universe-режима. |
| `BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB` | int | no | `8` |  |  | backtester-service | 17c: память на символ (MiB) поверх базы для universe-контейнера. |
| `BACKTESTER_UNIVERSE_SESSION` | bool | no | — |  | flag: off/enforce, default off | backtester-service | 17c: все символы бандла в ОДНОМ контейнере (N per-symbol инстансов; dark launch). |
| `BACKTESTER_WALK_FORWARD_ENABLED` | bool | no | — |  | flag: off/enforce, default off | backtester-service | E3b: walk-forward per-fold исполнение (dark launch, PR #121). |
| `BACKTESTER_WALK_FORWARD_MAX_FOLDS` | int | no | `20` |  |  | backtester-service | E3b: policy-cap числа фолдов (safe-целое >= 1; мусор → 20). |
| `BENCH_API_PORT` | int | no | `18080` |  |  | backtester-devtools | bench-workers: порт API-ноды бенча. |
| `BENCH_CONC` | csv | no | `1,2,4` |  |  | backtester-devtools | bench-workers: список степеней конкурентности прогона (через запятую). |
| `BENCH_MODE` | enum(momentum, sandbox) | no | `momentum` |  |  | backtester-devtools | bench-workers: режим бенча (незнакомое значение НЕ валидируется — приводится as-cast). |
| `BENCH_N` | int | no | — |  |  | backtester-tests | Bench: число submit; дефолт зависит от потребителя (6 в bench-parallel-drain, клампится к >= 2; 120/12 по режиму в bench-workers). |
| `BENCH_PG_PORT` | int | no | `55432` |  |  | backtester-devtools | bench-workers: порт одноразового Postgres бенча. |
| `BENCH_SESSION_BUDGET_MS` | duration_ms | no | `600000` |  |  | backtester-devtools | bench-workers: wall-time бюджет sandbox-сессии (sub#4 knob). |
| `BT_EVIDENCE_SIGNING_KEY` | string | no | — | yes |  | backtester-service | PEM PKCS8 Ed25519 приватный ключ подписи backtest-evidence. Не задан = подпись OFF (эфемерные ключи не генерируются — keyId должен быть в allowlist платформы). |
| `DATABASE_URL` | url | no | — | yes |  | backtester-service | Postgres connection string: задан — PgJobStore, нет — in-memory. worker-main требует его (fail-fast в entrypoint). |
| `DATA_API_FIXTURES_DIR` | string | no | — |  |  | backtester-data-api | Референс data-api: каталог fixture-датасетов; дефолт вычисляется: apps/backtester/fixtures/candles. |
| `DATA_API_HOST` | string | no | `127.0.0.1` |  |  | backtester-data-api | Референс data-api: bind-адрес. |
| `DATA_API_PORT` | int | no | `8081` |  |  | backtester-data-api | Референс data-api: порт. |
| `DATA_API_TOKEN` | string | no | — | yes |  | backtester-data-api | Референс data-api: bearer-токен; не задан = auth выключен (dev-инструмент). |
| `LONGOI_BUNDLE` | string | no | — |  |  | backtester-devtools | produce-long-oi-evidence: путь к long-oi бандлу; дефолт вычисляется (локальный путь разработчика). |
| `LONGOI_BUNDLE_HASH` | string | no | `sha256:38fe5286dd8152da7a74e043576b2a9333ec23950839cb25289881bfe2c4416c` |  |  | backtester-devtools | produce-long-oi-evidence: ожидаемый hash бандла (integrity-пин). |
| `LONGOI_DIAG` | string | no | — |  |  | backtester-devtools | produce-long-oi-evidence: значение 1 включает диагностический вывод. |
| `LONGOI_SNAPSHOT` | string | no | — |  |  | backtester-devtools | produce-long-oi-evidence: путь к snapshot-файлу датасета. |
| `PLATFORM_REPO` | string | no | — |  |  | backtester-tests | Путь к чекауту trading-platform для cross-repo/evidence/golden-sync тестов; дефолт вычисляется (локальный путь разработчика), без чекаута тесты скипаются. |
| `PNL_TOL` | float | no | `0.0001` |  |  | backtester-devtools | validate-execution: допуск сверки PnL с эталоном. |
| `RUN_BENCH` | string | no | — |  |  | backtester-tests | Значение 1 включает bench-parallel-drain (иначе skip). |
| `RUN_CROSS_REPO_E2E` | bool | no | `false` |  |  | backtester-tests | true включает opt-in cross-repo historical E2E (детерминизм-гейт против реального platform-чекаута). |
| `SLICE_PATH` | string | no | — |  |  | backtester-devtools | Скрипты фикстур/валидации: путь к slice-файлу исторических данных; дефолт вычисляется per-скрипт. |
| `TAPE_CACHE_MAX_ENTRIES` | int | no | `16` |  |  | backtester-service | Ёмкость LRU tape-кэша воркера; 0 = выключить кэш; мусор → 16. Читается при создании синглтонов. |
| `WORKER_CONCURRENCY` | int | no | `4` |  |  | backtester-worker | Максимум одновременных backtest-ранов in-process worker-пула (клампится к >= 1; 1 = serial). |
| `WORKER_ERROR_BACKOFF_BASE_MS` | duration_ms | no | `500` |  |  | backtester-worker | P2-7: первый бэккофф после ошибки итерации worker-loop (клампится к >= 50; удваивается). |
| `WORKER_ERROR_BACKOFF_MAX_MS` | duration_ms | no | `30000` |  |  | backtester-worker | P2-7: потолок бэккоффа worker-loop (клампится к >= base). |
| `WORKER_HEALTH_PORT` | int | no | — |  |  | backtester-worker | TCP-порт health-сервера воркера (/healthz + /readyz); не задан = сервер не поднимается. |
| `WORKER_HEARTBEAT_MS` | duration_ms | no | `10000` |  |  | backtester-worker | Интервал heartbeat: воркеры продлевают in-flight lease (клампится к >= 1000). |
| `WORKER_ID` | string | no | — |  |  | backtester-worker | Стабильный id worker-процесса (владелец lease); дефолт вычисляется: hostname:pid. |
| `WORKER_LEASE_TTL_MS` | duration_ms | no | `30000` |  |  | backtester-worker | Lease TTL при claim (клампится к >= 3 * heartbeat; см. P3-5 guidance в config.ts). |
| `WORKER_MAX_ATTEMPTS` | int | no | `3` |  |  | backtester-worker | Максимум claim-попыток до пометки повторно-осиротевшего job как poison. |
| `WORKER_POLL_MS` | duration_ms | no | `500` |  |  | backtester-worker | Интервал idle-опроса пустой очереди (клампится к >= 50). |
