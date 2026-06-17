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
- `packages/research-contracts/` — контракты research-интерфейса
- `packages/client/` — клиент (`@trading-backtester/client`, его использует trading-lab)
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
