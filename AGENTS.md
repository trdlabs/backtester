# AGENTS.md — trading-backtester

> Гид для AI-агентов (Codex, Claude Code и др.). Поведенческие правила и обязательный
> workflow по навигации (Gortex MCP) — в `CLAUDE.md`. Здесь — быстрый контекст и команды.

## Что это
**Отдельный research-backtesting сервис** для экосистемы `trading-*`. Принимает
модули стратегий/гипотез от `trading-lab`, прогоняет **детерминированные** research-бэктесты,
хранит свой async-lifecycle задач и артефакты результатов, отдаёт status/result/artifacts по HTTP.

⚠️ **Не держит биржевых кредов.** Исторические данные получает через data-port, принадлежащий
платформе → реальный `trading-platform` и `trading-mock-platform` взаимозаменяемы.

### Текущие слайсы
- **Slice 1** — тонкий «хребет»: HTTP API + async lifecycle + idempotency +
  content-addressed artifact store + детерминированный `result_hash`.
- **Slice 2** — durable store: Postgres `PgJobStore`, атомарные переходы (терминальные
  статусы immutable), `claimNextQueued` (`FOR UPDATE SKIP LOCKED`), idempotency через restart,
  outbox + webhook с ретраями. Тесты гоняются против **обоих** стораджей, golden `result_hash` идентичен.
- **Slice 3** — sandboxed untrusted bundles: `moduleBundle` content-addressed (`bundleHash`),
  исполняется в заблокированном Docker (`--network none`, read-only rootfs, `--cap-drop ALL`,
  без env/secrets, лимиты cpu/mem/pids). Нарушения лимитов → чистый терминальный статус+код,
  никогда не краш сервиса.

## Стек
- **TypeScript**, монорепо на **pnpm** (`pnpm-workspace.yaml`)
- **tsx** для запуска/дев, **Vitest** для тестов, **pg** (Postgres)
- Docker — изолированное исполнение бандлов (Slice 3)

## Структура
- `apps/backtester/` — сам сервис: `src/`, `test/`, `migrations/`, `fixtures/`, `sandbox-harness/`
- `packages/sdk/` — **`@trading-backtester/sdk`** (Apache-2.0) — канонический публичный пакет с
  4 subpath-экспортами (`/contracts`, `/builder`, `/client`, `/artifacts`). Устанавливается через
  GitHub Release `.tgz` (без npm-регистри). Workflow для релиза есть
  (`.github/workflows/sdk-release.yml`), но **версия `0.1.0` ещё не опубликована**.
  Ядро детерминизма (`canonical-json`, хэширование) живёт в SDK; сервис потребляет его через
  тонкие re-export обёртки. Живых кредов и биржевого исполнения нет — SDK чисто для авторинга и
  интеграции с API.
- `packages/research-contracts/` — `@trading/research-contracts` — **приватный** пакет для
  исторических/engine-only типов (`HistoricalDatasetReader`, canonical rows, engine
  context/decisions/indicators/market-tape). Остаётся приватным.
- `packages/client/` — `@trading-backtester/client` — **заморожен** до отдельного cutover в
  `trading-lab`; ещё не удалён и не является обёрткой над SDK.
- `docs/ARCHITECTURE.md` — полная MVP-архитектура и решения (ADR)

## Команды
```bash
pnpm install
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest run (включая параметризацию по обоим стораджам)
pnpm test:watch
pnpm dev                 # tsx watch apps/backtester/src/index.ts
pnpm start               # tsx apps/backtester/src/index.ts
```

## Правила для агента
- **Детерминизм — главный инвариант.** Один и тот же bundle → один и тот же `result_hash`,
  независимо от стораджа и от sandbox-окружения. Не вводи источники недетерминизма (время, рандом, порядок).
- **Никаких биржевых кредов** и прямого доступа к биржам — только data-port.
- Терминальные статусы immutable; новые ошибки маппь в таксономию кодов, не давай сервису крашиться.
- Изменения в стораджах проверяй на обоих бэкендах (in-memory + Pg).
- Sandbox-ограничения (network none, cap-drop, лимиты) не ослабляй без явной задачи.
- Перед правкой поведения читай реальную реализацию через `get_symbol_source` (см. CLAUDE.md), не по краткой сводке.

## Навигация по коду
**Обязательно** используй Gortex MCP (`graph_stats`, `smart_context`, `get_editing_context`,
`verify_change`, `get_edit_plan`/`batch_edit`, `check_guards`, `get_test_targets`) вместо Read/Grep/Glob —
PreToolUse hooks блокируют прямое чтение индексированного кода. Подробный workflow — в `CLAUDE.md`.

<!-- gortex:communities:start -->
<!-- gortex:skills:start -->
## Community Skills

| Area | Description | Skill |
|------|-------------|-------|
| Src Engine 2 Dirs | 155 symbols | `/gortex-src-engine-2-dirs` |
| Engine Sandbox 2 Dirs Mapfailure | 133 symbols | `/gortex-engine-sandbox-2-dirs-mapfailure` |
| Engine Validation 2 Dirs | 129 symbols | `/gortex-engine-validation-2-dirs` |
| Src Engine 1 Dirs Pointintimemarketapi | 79 symbols | `/gortex-src-engine-1-dirs-pointintimemarketapi` |
| Src Engine Settlepending | 73 symbols | `/gortex-src-engine-settlepending` |
| Src Jobs 1 Dirs Processnextqueued | 72 symbols | `/gortex-src-jobs-1-dirs-processnextqueued` |
| Src Engine 1 Dirs Runbacktest | 69 symbols | `/gortex-src-engine-1-dirs-runbacktest` |
| Backtester Test 3 Dirs Buildoverlaydataset | 55 symbols | `/gortex-backtester-test-3-dirs-buildoverlaydataset` |
| Engine Indicators 2 Dirs | 52 symbols | `/gortex-engine-indicators-2-dirs` |
| Client Src 1 Dirs | 50 symbols | `/gortex-client-src-1-dirs` |
| Src Engine Buildtrade | 45 symbols | `/gortex-src-engine-buildtrade` |
| Backtester Src Buildapp | 43 symbols | `/gortex-backtester-src-buildapp` |
| Src Engine 1 Dirs Kindcoverage | 43 symbols | `/gortex-src-engine-1-dirs-kindcoverage` |
| Src Jobs 1 Dirs Submitrun | 41 symbols | `/gortex-src-jobs-1-dirs-submitrun` |
| Src Runner Runbacktest | 40 symbols | `/gortex-src-runner-runbacktest` |
| Src Jobs Rowtojob | 40 symbols | `/gortex-src-jobs-rowtojob` |
| Src Engine Computemetrics | 40 symbols | `/gortex-src-engine-computemetrics` |
| Src Engine 1 Dirs Buildmarkettape | 40 symbols | `/gortex-src-engine-1-dirs-buildmarkettape` |
| Backtester Test 3 Dirs Tooverlaysummary | 37 symbols | `/gortex-backtester-test-3-dirs-tooverlaysummary` |
| Backtester Src Persistoverlayartifacts | 35 symbols | `/gortex-backtester-src-persistoverlayartifacts` |
<!-- gortex:skills:end -->

<!-- gortex:communities:end -->
