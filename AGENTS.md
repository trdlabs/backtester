# AGENTS.md — trading-backtester

This repository is part of the `trdlabs` trading ecosystem.

**Before planning or coding, read `../control-center/` when the task involves:**
- other repositories, system architecture, or integration boundaries
- API, MCP, SDK, or contract changes
- rollout, migration, or cross-repo validation
- local development, Docker, running the full ecosystem stack, or mock-platform data intervals
- fetching a new VPS snapshot and making it the ecosystem default fixture

**Read order when triggered:**
1. `../control-center/repos.yaml`
2. `../control-center/AGENTS.md`
3. `../control-center/repos/trading-backtester.md`
4. `../control-center/docs/operations/local-development.md` when starting or debugging the local stack
5. `../control-center/docs/operations/mock-platform-data.md` when historical intervals (1m/1h/1d) or mock fixtures matter
6. `../control-center/docs/operations/mock-platform-snapshot-rollout.md` when ingesting a VPS slice or changing the default fixture across repos
7. `../control-center/ecosystem-defaults.yaml` and skill `mock-snapshot-default-rollout` when making a VPS slice the ecosystem default

If `../control-center` is absent (standalone clone), use local repo docs only.

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
- `packages/sdk/` — **`@trdlabs/backtester-sdk`** (Apache-2.0) — канонический публичный пакет с
  4 subpath-экспортами (`/contracts`, `/builder`, `/client`, `/artifacts`). Каноническая доставка —
  **public npm registry**; выпуск идёт через `.github/workflows/sdk-release.yml`. GitHub Release и
  git-тег `sdk-v*` создаются ПОСЛЕ успешной публикации как release note и каналом доставки не
  являются (до 0.8.0 канал был обратный — `.tgz` из GitHub Release; в старых документах и обсуждениях
  встречается именно та схема).
  Не хардкодь список опубликованных версий в документации: сверяй `packages/sdk/package.json` и
  `npm view @trdlabs/backtester-sdk versions` перед release/consumer rollout — в реестре может быть
  меньше версий, чем git-тегов, именно из-за смены канала.
  Ядро детерминизма (`canonical-json`, хэширование) живёт в SDK; сервис потребляет его через
  тонкие re-export обёртки. Живых кредов и биржевого исполнения нет — SDK чисто для авторинга и
  интеграции с API.
- **Не путай два публичных SDK с разными владельцами и каналами доставки:**

  | Пакет | Владелец | Назначение | Каноническая доставка |
  | --- | --- | --- | --- |
  | `@trdlabs/backtester-sdk` | этот репозиторий, `packages/sdk/` | API/контракты backtester для lab | public npm registry (`npm install @trdlabs/backtester-sdk`) |
  | `@trdlabs/sdk` | sibling `../sdk` (`trdlabs/sdk`) | platform-facing client, включая `/historical` | public npm registry (`npm install @trdlabs/sdk`) |

  Для изменений, релиза или bump `@trdlabs/sdk` сначала читай
  `../control-center/docs/operations/npm-publishing.md` и
  `../control-center/docs/delivery/sdk-consumer-rollout-checklist.md`. Оба пакета публикуются в npm,
  но это РАЗНЫЕ пакеты с разными владельцами и своими release-путями — не переноси workflow одного
  на другой.
- `packages/research-contracts/` — `@trading/research-contracts` — **приватный** пакет для
  исторических/engine-only типов (`HistoricalDatasetReader`, canonical rows, engine
  context/decisions/indicators/market-tape). Остаётся приватным.
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

<!-- Перенесено из CLAUDE.md 2026-08-20 при сведении инструкций в один файл.
     Держать ВНЕ маркеров gortex:*, иначе `gortex init` затрёт. -->

## Codebase Overview (generated by Gortex)

- **Languages:** typescript (primary), contract, gitignore, go, javascript, json, markdown, mcp_config, sql, yaml
- **Entry points:** `apps/backtester/sandbox-harness/entry.mjs`, `apps/backtester/scripts/build-sandbox-harness-overlay.mjs`, `apps/backtester/src/data-api-main.ts`, `apps/backtester/src/index.ts`, `apps/backtester/sandbox-harness-overlay/entry.mjs`
- **Most-referenced symbols:** `makeIssue` (39 usages), `reject` (12 usages), `asRecord` (12 usages), `key` (10 usages), `key` (10 usages), `request` (9 usages), `rejected` (9 usages), `requireSymbol` (8 usages), `get` (8 usages), `fillPrice` (7 usages)
- **Graph size:** 4048 nodes, 9031 edges
- **Breakdown:** 33 columns, 28 contracts, 108 docs, 209 files, 456 functions, 4 generic_params, 495 imports, 263 interfaces, 964 locals, 143 methods, 1 migrations, 5 modules, 1 packages, 677 params, 2 resources, 2 strings, 2 tables, 107 types, 548 variables

## MANDATORY: Use Gortex MCP tools instead of Read/Grep/Glob

Gortex is running as an MCP server. You **MUST** prefer graph queries over file reads on every task in this repo — `search_symbols`, `find_usages`, `get_symbol_source`, `get_editing_context`, `smart_context`, `edit_symbol` / `edit_file` / `rename_symbol` / `batch_edit`. PreToolUse hooks deny `Read` / `Grep` / `Glob` against indexed source; the deny message names the right tool. The full per-tool catalog loads via `tools/list` — not restated here.

### Calibration: the graph narrows scope, source confirms behavior

The mandate above stands — but graph queries *narrow scope*, they do not *replace reading the implementation*. The graph tells you **where** the logic lives and **what** connects to it; the source tells you **how** it behaves. For the symbol you are about to change or depend on, read its full body with `get_symbol_source` — do not act on a one-line summary alone.

Be especially deliberate with **behavior-critical code** — database migrations, retry / fallback / error-recovery paths, compatibility shims, concurrency-sensitive sections, and the tests that pin them. For these, call `get_symbol_source` and read the real implementation; never pass `compress_bodies:true`, which elides exactly the branches that carry the risk. Reserve compressed bodies and graph summaries for breadth (surveying many symbols); use full source for the few you are about to commit to.

## Required workflow (every task on this repo)

These are not suggestions — run each step at the trigger.

1. **Always call** `graph_stats` first to confirm the daemon is up and orient (check `per_repo` in multi-repo mode).
2. If `total_nodes` is 0, **call** `index_repository` with `"."` before anything else.
3. In multi-repo mode, **call** `get_active_project` to check scope; use `set_active_project` to switch.
4. For every new task, **call** `smart_context` with the task description before reading any file.
5. Before editing a file, **call** `get_editing_context` on it first.
6. Before changing any function signature, **call** `verify_change` to catch broken callers and interface implementors (cross-repo).
7. For any refactor, **call** `get_edit_plan` then `batch_edit` to apply atomically.
8. After every edit, **call** `check_guards` then `get_test_targets`.

