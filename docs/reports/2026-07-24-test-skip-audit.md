# Skip-аудит тестов backtester (TQ-1)

Дата: 2026-07-24
Карточка: control-center [`test-quality-hardening`](../../../control-center/docs/delivery/initiatives/test-quality-hardening.md), пункт TQ-1
Воспроизведение: `pnpm test:skips` (markdown), `pnpm test:skips -- --json`, `pnpm test:skips -- --check` (гейт)
Классификатор: `apps/backtester/scripts/lib/skip-audit.ts`; гейт в обычном прогоне: `apps/backtester/test/skip-audit.test.ts`

## Вывод

Отчёт 15 насчитал «51 файл со skip» — число получено `grep`-ом по подстроке и само по себе
ничего не говорит: оно одинаково считает честный средовой гейт и молча выключенный тест.
Машинный разбор показывает другую картину.

**Вся skip-поверхность backtester условная.** 51 сайт из 52 — `describe.skipIf` / `it.skipIf`
с выражением, зависящим от среды; безусловных пропусков без обоснования и `.only` — ноль.

Единственный безусловный `it.skip` — намеренно отложенный тест паритета сигналов
(`test/long-oi-parity/signal-parity.test.ts`, ждёт фикса `ctx.market` в live-адаптере платформы).
Он получил прагму `// skip-audit:allow — <причина>`, то есть перестал быть невидимым.

Единый паттерн гейтинга уже существовал де-факто — `DOCKER_AVAILABLE` / `PG_AVAILABLE` из
`test/store-factories.ts` (+ `factory.available` в параметризации по стораджам) покрывают 44 сайта
из 51. Одно отклонение исправлено: `test/golden-sync.test.ts` подменял `it` на `it.skip` через
тернарник (`platformReachable ? it : it.skip`) — переписано на `it.skipIf(!platformReachable)`.

Три гейта класса `other` — не ad-hoc, а именованные локальные константы, которые классификатор
не сопоставляет с шаблоном по имени:

| Файл | Гейт | Чем является на самом деле |
| --- | --- | --- |
| `test/cross-repo-historical-e2e.integration.test.ts:216` | `!enabled` | `RUN_CROSS_REPO_E2E === 'true' && existsSync(PLATFORM_REPO)` — env-opt-in + наличие соседнего репо |
| `test/data-api.test.ts:109` | `!EXT_AVAILABLE` | результат пробы `externalReachable()` |
| `test/golden-sync.test.ts:39` | `!platformReachable` | `existsSync(PLATFORM_GOLDEN_PATH)` |

Все три — среда, не выключенный тест. Переименование ради красивой колонки в отчёте того не стоит.

**Анти-дрейф.** Классификация зафиксирована гейтом внутри `pnpm test`: `skip-audit.test.ts`
падает, если в репо появится `.only` или безусловный `.skip`/`.todo` без прагмы. Отдельный шаг в
CI-workflow не добавлялся — гейт едет в обычном `vitest run`.

По итогам ревью гейт закрыт от четырёх способов обойти его молча: ошибка разбора литерала
(незакрытый бэктик, regex в `return`-позиции) больше не глушит остаток файла, корни аудита
выведены из include `vitest.config.ts` (иначе `scripts/**/*.test.ts` — реально исполняемые
тесты — оставались невидимыми), распознаются цепочки вида `it.concurrent.skip` и пробелы вокруг
точек, а прагма без текста причины не считается обоснованием. Каждый случай запинен регресс-тестом.

**Для TQ-2.** Пороги coverage можно строить поверх этой поверхности: доля молча выключенных
тестов — ноль, так что coverage не будет завышен мёртвыми тестами. Условная поверхность зависит
от среды прогона (Docker/Postgres), поэтому пороги имеет смысл считать на CI-лейне с поднятым
`postgres:16-alpine` и доступным Docker — иначе 51 сайт уедет в skip и картина будет неполной.

## Сводка

Сайтов модификаторов: **52** в 49 файлах.

| Класс | Сайтов | Что это |
| --- | --- | --- |
| `gated` | 51 | условный пропуск по среде (`skipIf`/`runIf`) |
| `allowed` | 1 | безусловный пропуск с прагмой-обоснованием |
| `unconditional` | 0 | молча выключенный тест — нарушение |
| `focused` | 0 | `.only` — нарушение |

## Условные гейты по видам

| Вид гейта | Сайтов |
| --- | --- |
| `docker` | 21 |
| `postgres` | 15 |
| `store-factory` | 8 |
| `fixture-file` | 4 |
| `other` | 3 |

## Нарушения

Нарушений нет: ни `.only`, ни безусловных `.skip`/`.todo` без прагмы.

## Аллоулист (осознанно отложенные тесты)

| Файл:строка | Сайт | Причина |
| --- | --- | --- |
| `apps/backtester/test/long-oi-parity/signal-parity.test.ts:50` | `it.skip` | DEFERRED: ждёт фикса ctx.market в live-адаптере платформы; инфраструктура matchTrades сохраняется намеренно |

## Разбивка по файлам

| Файл | gated | allowed | unconditional | focused |
| --- | --- | --- | --- | --- |
| `apps/backtester/test/api.e2e.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/async-sandbox-overlap.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/bar-batching-equivalence.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/bar-major-batch-golden.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/bar-major-golden.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/bench-parallel-drain.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/bundle-ref-dedup-pg.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/completion.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/concurrent-claim.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/cross-repo-historical-e2e.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/data-api.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/dedup-equivalence.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/dedup-result-cache.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/dedup-worker.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/docker-driver-dispose.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/evidence-conformance.test.ts` | 3 | 0 | 0 | 0 |
| `apps/backtester/test/evidence-harness.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/find-by-resume-token.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/golden-sync.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/idempotency.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/long-oi-parity/signal-parity.test.ts` | 0 | 1 | 0 | 0 |
| `apps/backtester/test/overlay-engine.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/overlay-sandbox-equivalence.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/overlay-sandbox-session.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/overlay-universe-equivalence.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/pg-coalesce-wake.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/pg-compute-lock.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/pg-reap-accepted.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/pool-options.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/promotion-attempt-ledger.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-cap.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-hardening.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-notify-emit-pg.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-notify-wake-pg.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-notify.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/queue-stats.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/reap-waiting-for-compute.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/restart-idempotency.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/sandbox.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/sdk-strategy-example.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/strategy-evidence-driver.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/strategy-evidence-http.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/strategy-route-worker.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/strategy-route.integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/terminal-result-api.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/universe-session-equivalence.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/walk-forward-integration.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/worker-lease.test.ts` | 1 | 0 | 0 | 0 |
| `apps/backtester/test/worker-loop.test.ts` | 2 | 0 | 0 | 0 |

