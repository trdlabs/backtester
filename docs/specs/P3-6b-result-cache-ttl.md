# P3-6b — TTL-эвикция result-cache (без синхронного удаления artifacts)

## Проблема (часть P3-6)

`backtest_result_cache` растёт безлимитно — нет TTL/эвикции. Каждый закэшированный compute оставляет
строку навсегда.

## Рамка (заказчик)

- **TTL удаляет ТОЛЬКО строки result-cache**; content-addressed artifacts (`template_ref`) синхронно НЕ
  удаляются — на них могут ссылаться completed jobs / signed evidence. Artifact GC — ОТДЕЛЬНЫЙ
  reachability + retention слайс (не 6b).
- **TTL от `createdAtMs`, без refresh-on-hit** (lookup не продлевает жизнь строки).
- **Default OFF** (флаг `resultCacheTtlMs`; unset ⇒ эвикции нет — поведение неизменно).
- **Bounded + indexed + throttled sweep**, одинаковая семантика InMemory/Pg.

## Решение

### 1. `ResultCache.sweepExpired(nowMs, ttlMs, batchLimit)`

`DELETE FROM backtest_result_cache WHERE created_at_ms < nowMs - ttlMs` — bounded (oldest-first, LIMIT
batchLimit), возвращает count. Artifacts не трогаются (только строки индекса). Одинаково в InMemory
(oldest-first slice) и Pg.

- **Index**: миграция `0011_result_cache_created_at_index.sql` — `CREATE INDEX … (created_at_ms)`.
- **Pg**: `DELETE … WHERE ctid IN (SELECT ctid … WHERE created_at_ms < $1 ORDER BY created_at_ms
  LIMIT $2 FOR UPDATE SKIP LOCKED)` — SKIP LOCKED, чтобы несколько worker-процессов не конкурировали за
  один batch (hardening из ревью #133, применён и здесь).

### 2. Maintenance-step (throttled), гейтед на `resultCacheTtlMs`

Отдельный от coalescing-maintenance (result-cache TTL независим от coalescing: dedup может быть ON при
coalescing OFF). `createResultCacheSweep(deps, opts)` — throttled шаг (не чаще `sweepIntervalMs`, default
= ttl), гейтед на `resultCacheTtlMs !== undefined && resultCache present`. Подключён в ОБА loop'а
(`runWorkerLoop` + `buildApp.tick()`), как и compute-lock sweep.

### 3. Retrofit: FOR UPDATE SKIP LOCKED в compute-lock sweep

Тот же hardening в `PgComputeLockStore.sweepExpired` (из ревью #133, «на будущее»).

### Config

`AppConfig.resultCacheTtlMs?: number` (optional; unset = OFF). Env `BACKTESTER_RESULT_CACHE_TTL_MS`.
Проброшен в `WorkerDeps` + `buildApp` (mirror `computeLockTtlMs`).

## Ревью #134 — уточнения

### Sweep cadence независим от retention (High #1)

Раньше default cadence = TTL → при 30-дневном TTL sweep шёл раз в 30 дней (backlog рос под нагрузкой).
Теперь default = `min(ttlMs, 60_000)` (не реже раза в минуту, независимо от длины retention), плюс
опциональный override `BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS` / `resultCacheSweepIntervalMs`. Тот же cap
применён к compute-lock sweep. Тест: 30-дневный TTL, два истёкших batch (batchLimit 1) — второй удаляется
через 60s cadence, НЕ через полный TTL.

### Fail-fast валидация TTL из env (High #2)

`BACKTESTER_RESULT_CACHE_TTL_MS` (и `_SWEEP_INTERVAL_MS`) должны быть ПОЛОЖИТЕЛЬНЫМ safe-integer (ms) —
иначе `loadConfig` бросает (fail-fast). unset/blank ⇒ OFF; `0`/`-1`/дробное/`NaN`/`Infinity`/мусор ⇒
throw. Config-тесты: unset, valid, blank, 0, negative, fractional, NaN, Infinity, garbage, interval-override.

## Инварианты

- **Default OFF**: без `resultCacheTtlMs` sweep не создаётся/не зовётся — result-cache байт-идентичен
  прежнему (lookup/put не меняются; TTL не влияет на result_hash).
- **Artifacts неприкосновенны**: sweep удаляет только строки cache; `template_ref` остаётся.
- **No refresh-on-hit**: `lookup` не трогает `created_at_ms`.
- Sweep best-effort (`.catch(() => {})`), bounded, throttled, over-index.

## Тесты (TDD)

Store (InMemory + Pg-gated):
1. **sweepExpired** — удаляет только `created_at_ms < now - ttl`, oldest-first, bounded batchLimit; свежие
   остаются; возвращает count.
2. **artifacts untouched** — sweep НЕ удаляет `template_ref` (artifact-store не трогается — проверяется
   тем, что sweep принимает только cache-стор, без artifact-store).
3. **no refresh-on-hit** — `lookup` не меняет `created_at_ms` (строка эвиктится по исходному времени).
Maintenance/wiring:
4. **result-cache sweep throttled** — `createResultCacheSweep`: истёкшая строка удаляется проходом; sweep
   не чаще интервала.
5. **buildApp integration** — `tick()` с `resultCacheTtlMs` set удаляет истёкшую cache-строку.
6. **default OFF** — без `resultCacheTtlMs`: sweep не вызывается (spy), cache-стор не трогается.
