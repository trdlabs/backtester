# Reference-backtest bench harness + bar-batching trio — design

Дата: 2026-07-24
Карточка: control-center [`dark-flag-validation`](../../../../control-center/docs/delivery/initiatives/dark-flag-validation.md), item 3 (батч 1)
Смежное: [`backtester-runtime-hardening`](../../../../control-center/docs/delivery/initiatives/backtester-runtime-hardening.md) item 4 (U8-перф-гейт — тот же станок)
Репо: `trading-backtester`

## Проблема

Три флага перф-трио — `BACKTESTER_BAR_BATCHING` (17b), `BACKTESTER_BAR_MAJOR` (17d)
и `BACKTESTER_BAR_MAJOR_BATCH` (Slice B) — смержены, покрыты golden/equivalence
тестами и **default off**. Тесты доказывают эквивалентность (`result_hash` не
меняется), но не измеряют выигрыш: у `bar-major-batch-golden.test.ts` нет ни
таймингов, ни счётчиков IPC. Замер на VPS (карточка `bar-major-vps-measure`)
делался разовым ad-hoc прогоном, воспроизвести его нечем.

Карточке нужен переиспользуемый станок: один референс-бэктест, матрица флагов,
таблица «hash == baseline» + тайминги. Тот же станок потом обслуживает U8.

## Решение

### `apps/backtester/scripts/bench-reference-backtest.mts`

Соседствует с `bench-workers.mts` (тот же жанр: не CI-ассерт, а измерительный
прогон, печатающий таблицу).

**Референс-прогон.** Та же фикстура, что у Docker-golden-гейта:
`test/fixtures/overlay/requests/universe-multi.json` (3 символа
BTCUSDT/ETHUSDT/SOLUSDT, `universe-fixture-1m`) + бандл
`short-after-pump.bundle.json`, исполняемый через `runBacktest` с sandbox-деками
(`buildSandboxStrategyBaselineDeps`) — то есть реальный Docker-контейнер и
реальный per-bar IPC, единственный путь, где эти флаги вообще что-то делают.
Фикстура переопределяется через `BENCH_REQUEST` / `BENCH_BUNDLE` — это и есть
переиспользуемость под U8.

**Матрица вариантов** (`BENCH_VARIANTS`, по умолчанию все четыре):

| Вариант | deps | Смысл |
| --- | --- | --- |
| `off` | — | baseline, все флаги выключены |
| `bar_batching` | `barBatching: true` | 17b |
| `bar_major` | `barMajor: true` | 17d Slice A |
| `bar_major_batch` | `barMajor + barMajorBatch` | 17d Slice B |

`barBatching` и `barMajor` взаимоисключимы (fail-fast в `config.ts`), поэтому
комбинации 5–8 не существует — матрица ровно четыре строки.

**Измеряется** за `BENCH_REPEATS` повторов (по умолчанию 3):

- wall ms на прогон (min / median), speedup к медиане baseline;
- `resultHash` — сверка с baseline (колонка byte-identity);
- агрегаты IPC-профиля: `hookCalls`, `barMajorBatches`, `ipcWaitMs`, `openMs`.
  Инструментация уже есть — `SandboxSession` при `BACKTESTER_IPC_PROFILE=true`
  печатает per-session JSON `{evt:'ipc_profile', …}` в stderr на `close()`.
  Флаг читается в статическом поле при загрузке модуля, поэтому харнесс
  выставляет env **до** динамического импорта движка, а строки собирает,
  временно подменив `console.error`.

**Вывод**: markdown-таблица в stdout + `--json <path>` для приложения к карточке.

**Вердикт byte-identity** формулируется явно: PASS, если хэш каждого варианта
совпал с baseline на каждом повторе; иначе FAIL с перечислением расхождений.
Расхождение — стоп-условие для владельца, а не повод «подкрутить» ожидание.

### Тесты

Docker-прогон в CI не ассертится (как и `bench-workers.mts`). Юнит-тестами
покрываются чистые части: разбор `BENCH_VARIANTS` (включая неизвестное имя →
внятная ошибка), маппинг варианта в deps-оверрайд, агрегация повторов
(median/min), парсер строк `ipc_profile`, формирование вердикта byte-identity
(PASS/FAIL). Файл `apps/backtester/test/bench-reference-harness.test.ts`;
чистые функции живут в `apps/backtester/scripts/lib/bench-reference.ts`,
`.mts`-скрипт остаётся тонким I/O-слоем.

## Что НЕ делается

- **Флаги не включаются по умолчанию.** Батч 1 даёт замер и вердикт; решение
  «включить дефолтом» — отдельный шаг rollout-таблицы карточки (шаг 4) и
  решение владельца.
- Staging-прогон на VPS — вторая половина item 3, отдельное операторное окно.
  Здесь — локальный прогон (WSL2, 4 ядра), помеченный как таковой: цифры годятся
  для сравнения вариантов между собой, но не как абсолютная capacity-оценка.
- Батч 2 (остальные сироты) — item 4 карточки, после протокола item 2.

## Критерии готовности

1. `pnpm exec tsx apps/backtester/scripts/bench-reference-backtest.mts` печатает
   таблицу из четырёх вариантов с byte-identity и таймингами;
2. локальный прогон выполнен, вердикт byte-identity зафиксирован;
3. `pnpm test` зелёный, включая юнит-тесты чистых частей харнесса;
4. таблица внесена в карточку `dark-flag-validation` (rule 8).
