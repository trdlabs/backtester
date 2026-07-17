# P2-12 — Data-fetch resilience: timeout, bounded retry, pagination guards

> **ИСПРАВЛЕНИЕ SCOPE (ревью #140).** Изначальная версия этой спеки ошибочно назвала контуром 2
> `@trdlabs/backtester-sdk` `BacktesterClient`. Настоящая цель P2-12 (CODE-REVIEW:100) — **`HttpDataPort`**
> + кросс-репный **`@trdlabs/sdk` `HistoricalClient`** (держит production `dataSource=real|mock` через
> `RowsDataPort`). Итоговое разбиение:
> - **#140 (этот репо)** — только `HttpDataPort` (контур 1), с закрытыми багами ревью #140: (2) timeout
>   охватывает fetch + чтение/парсинг body; (3) backoff ограничен operation deadline (Retry-After не
>   переполняет дедлайн).
> - **Кросс-репный PR (`../sdk`)** — захардить `HistoricalClient` (`discover`/`coverage`/`queryRows`) теми
>   же гарантиями; затем bump `@trdlabs/sdk` в backtester + wire `RowsDataPort`. Это закрывает production.
> - **Отдельный `@trdlabs/backtester-sdk` 0.9 PR** — `BacktesterClient` timeout/abort (полезно, но не цель
>   P2-12), с закрытыми багами (2) body-under-timeout и (4) abortable backoff/polling sleep. Убран из #140.

Из `CODE-REVIEW-2026-07-12.md` P2-12 (строка 100). Два ownership-контура, одна спека:

1. **Backtester `HttpDataPort`** (`apps/backtester/src/data/http-data-port.ts`, `dataSource=http`) —
   per-request timeout (fetch + body), bounded retry, deadline-capped backoff, cursor-cycle, max pages/rows.
2. **`@trdlabs/sdk` `HistoricalClient`** (кросс-репный `../sdk/src/historical/client.ts`) — держит
   PRODUCTION `dataSource=real|mock` через `RowsDataPort`; те же гарантии на `discover`/`coverage`/`queryRows`.

## Проблема

- `HttpDataPort`: `listDatasets`/`openDataset`/`queryRange` зовут `fetch` **без** `AbortController` —
  зависший ответ платформы блокирует claiming-воркер навсегда (`runTimeoutMs` — концепт репера дедлайнов,
  не abort in-flight fetch). `queryRange` — `for(;;)` по `cursor`, выходит только на falsy `nextCursor`:
  upstream, вечно эхоящий тот же курсор, даёт бесконечный fetch-loop, а `materialize()` (аккумулирует ВСЕ
  строки в `Map<symbol, ReaderRow[]>`) растёт без границы → OOM. Ошибки — generic `throw new Error(...)`,
  не мапятся в data-taxonomy.
- `HistoricalClient` (`@trdlabs/sdk`): `discover`/`coverage`/`queryRows` зовут `fetch` **без**
  `AbortController` — зависший ответ (заголовки ИЛИ стопнувшийся body) вешает потребляющий воркер навсегда;
  `queryRows` — тот же `for(;;)` по `cursor`, выход только на `nextCursor === null` (эхо-курсор → ∞-loop +
  рост `materialize()` у потребителя). Ошибки — generic `Error` c `HTTP <status>` (сохранить для
  backtester `classifyDiscoverError`).

## Обязательные правила (оба контура)

- **retry только для idempotent GET** (и mutation c `resumeToken` — replay-контракт SDK) и **transient**
  сбоя: сетевой error, `408`, `429`, `5xx`.
- **общий attempt cap** + **bounded exponential backoff** (base·2^(n-1), потолок, full jitter).
- **caller abort имеет приоритет и НЕ ретраится** — `AbortError` от переданного `signal` пробрасывается
  немедленно.
- **timeout ограничивает КАЖДЫЙ запрос** (per-request `AbortController`); **общий operation deadline** —
  желателен (bounds всю cursor-пагинацию/materialize).
- **повторившийся `nextCursor`** (равен предыдущему) → typed error (`pagination_cycle`), НЕ бесконечный loop.
- **`maxPages` и `maxRows`** — fail-closed ДО роста памяти (проверяются в cursor-loop перед накоплением).
- **`4xx` кроме `408`/`429` не ретраятся** (permanent).
- **ошибки мапятся в существующую taxonomy**, воркер не зависает.
- **config-числа fail-fast** валидируются в `loadConfig` (finite, положительные, `maxDelay >= baseDelay`).

## Контур 1 — `HttpDataPort`

**Внутренний resilient-fetch helper** (`resilientFetch(url, headers, opts, signal?)`):
- Per-request `AbortController`; `setTimeout(timeoutMs)` → abort → attempt падает как transient `timeout`.
- Переданный caller `signal` линкуется в тот же контроллер; его abort — **не** transient (приоритет,
  no-retry).
- Retry-loop: attempt cap `maxAttempts`; retry только на transient (сетевой throw / `408` / `429` / `5xx`);
  `4xx≠408/429` → сразу raise; между попытками — bounded expo backoff (base/cap + full jitter),
  abort-прерываемый; опциональный operation deadline обрывает весь loop.
- `429` — уважает numeric `Retry-After`, clamped (как в SDK).

**Cursor-пагинация `queryRange`** (внутри `for(;;)`):
- Трекать `prevCursor`; если новый `nextCursor === prevCursor` (или уже виден) → `RealDataUnavailableError('pagination_cycle', ref)`.
- Счётчики `pages`/`rows`; `pages > maxPages` или `rows + page.rows.length > maxRows` → fail-closed
  `RealDataUnavailableError('pagination_overflow', ref)` ДО `yield` (до накопления в `materialize`).
- `yield` страницы как раньше (lazy back-pressure сохраняется).

**Taxonomy.** `HttpDataPort` бросает **`RealDataUnavailableError`** (существующий тип; worker.ts:1074-1077
уже мапит `instanceof RealDataUnavailableError → 'missing_dataset'`, message-контракт `cause=…; datasetRef=…`).
`RealDataCause` расширяется: `+ 'timeout' | 'pagination_cycle' | 'pagination_overflow' | 'rate_limited'`.
Маппинг статусов: `401/403 → unauthorized`, `404 → dataset_not_found` (openDataset уже возвращает
`undefined` на 404 — сохраняем), `429 (исчерпан) → rate_limited`, `5xx/сеть (исчерпан) → rows_resource_unavailable`,
прочий `4xx → discover_failed`. Расширение union безопасно: worker мапит ЛЮБОЙ `RealDataUnavailableError`
в один terminal-код `missing_dataset` — новые причины лишь обогащают errorDetail.

**Config (fail-fast).** Новые поля (`config.ts` + `HttpDataPortOptions`, wired в `app.ts`):
`dataApiTimeoutMs` (per-request, default 30_000), `dataApiMaxAttempts` (3), `dataApiRetryBaseMs` (500),
`dataApiRetryMaxMs` (10_000), `dataApiMaxPages` (10_000), `dataApiMaxRows` (5_000_000),
`dataApiOperationDeadlineMs` (0 = off). Валидация: все finite; timeout/attempts/pages/rows/base ≥ 1;
`retryMax ≥ retryBase`; иначе `loadConfig` бросает с явным сообщением. Дефолты byte-identical к текущему
поведению по РЕЗУЛЬТАТУ (успешный happy-path не меняется — только добавляются границы на сбое).

## Контур 2 — `@trdlabs/sdk` `HistoricalClient` (кросс-репно, PR `trdlabs/sdk#16`)

Настоящий production-фикс `dataSource=real|mock`: `RowsDataPort` целиком делегирует в этот клиент. Зеркалит
resilient-request слой из Контура 1, но клиент **generic** (без backtester-типов), поэтому бросает `Error`.

- Внутренний `resilientJson<T>(r, url, label, deadlineAt, readBody)`: per-request `AbortController` +
  `setTimeout(timeoutMs)`, окно таймаута **охватывает fetch И чтение/парсинг body**; retry только на
  transient (network / body-parse / `408` / `429` / весь `5xx`), `4xx≠408/429` → fail-fast; между попытками
  `sleepBounded` (bounded expo backoff + full jitter, **ограничен operation deadline** — Retry-After не
  переполняет дедлайн); `429` уважает numeric Retry-After (clamped).
- `discover`/`coverage` → `resilientJson(readBody=true)`. `queryRows` → per-page `resilientJson` +
  cursor-cycle (`nextCursor === cursor || seen`) + fail-closed `maxPages`/`maxRows` ДО `yield`.
- **Ошибки — generic `Error`** c сохранением сообщения `platform /historical/<path>: HTTP <status>` (чтобы
  backtester `classifyDiscoverError` продолжал маппить discover-ошибки); timeout → `… timeout after Nms`;
  cycle/overflow/deadline → явные сообщения. Backtester-сторона (consumer) при желании маппит их в taxonomy.
- Новые опции `HistoricalClientOptions` (`timeoutMs`/`maxAttempts`/`retryBaseMs`/`retryMaxMs`/`maxPages`/
  `maxRows`/`operationDeadlineMs`/`sleepImpl`) — все опциональны, консервативные дефолты, **happy-path не
  меняется**. Minor **0.9.5 → 0.10.0**; репозиторий без unit-харнесса — добавлен `node:test` suite + `test`.
- **Consumer-gate (backtester, после релиза 0.10.0):** bump `@trdlabs/sdk` dep + `RowsDataPortOptions`
  прокидывает resilience-опции (из `config` через `app.ts`) в `new HistoricalClient(...)`; прогнать real/mock
  integration. Только после этого P2-12 считается полностью закрытым.

## Контур 2b — `@trdlabs/backtester-sdk` `BacktesterClient` (НЕ цель P2-12, отдельный PR)

Полезное, но **не** часть P2-12 (это lab-facing SDK). Ошибочно попал в #140 (ревью #140 §1) → откачен,
перевезён в отдельный `@trdlabs/backtester-sdk` 0.9 PR. Там закрыть баги ревью #140: **§2** timeout
охватывает body-read, **§4** backoff/polling `sleep` — abort-прерываемый (caller abort не ждёт до 60с).
Additive minor 0.8.0→0.9.0 (4 сайта версии); релиз — свой release train, после ревью.

## Инварианты

- Happy-path результат не меняется (goldens/`result_hash` не затронуты — это транспортный слой, не движок).
- Дефолты консервативны: границы срабатывают только на реальном сбое/зависании/зацикливании.
- `HttpDataPort` покрывает `dataSource=http`; `real`/`mock` покрываются Контуром 2 (`HistoricalClient` +
  consumer-wiring `RowsDataPort`). `MockPlatformDataPort` / `FixtureDataPort` не трогаем (своя семантика).

## Тесты (TDD, по контуру)

**Слайс 1 — `HttpDataPort`** (инъекция `fetchImpl` через `HttpDataPortOptions`):
1. **hanging fetch** — fetch никогда не резолвится → per-request timeout → transient → (при исчерпании)
   `RealDataUnavailableError('timeout')`; НЕ виснет.
2. **transient recovery** — первые N попыток `503`/network-throw, затем `200` → успех в пределах cap.
3. **permanent failure** — стабильный `500` → после cap `RealDataUnavailableError('rows_resource_unavailable')`.
4. **4xx no-retry** — `400`/`401` → ровно 1 попытка, немедленный raise (`unauthorized`/`discover_failed`).
5. **abort priority** — caller `signal.abort()` во время retry/backoff → немедленный `AbortError`, без ретраев.
6. **cursor loop** — upstream эхоит тот же `nextCursor` → `RealDataUnavailableError('pagination_cycle')` (не ∞).
7. **page overflow** — страниц > `maxPages` → fail-closed `pagination_overflow` до накопления.
8. **row overflow** — суммарно строк > `maxRows` → fail-closed `pagination_overflow` до `materialize`-роста.
9. **config fail-fast** — невалидные числа (`0`/`NaN`/`retryMax<retryBase`) → `loadConfig` бросает.

Плюс `bug2` (hung BODY → timeout, не только headers) и `bug3` (Retry-After sleep ограничен operation
deadline) — ревью #140 §2/§3.

**Контур 2 — `HistoricalClient`** (`node:test` в `../sdk`, инъекция `fetchImpl` + `sleepImpl`):
10. **hung fetch / hung body** — per-request timeout (охватывает body) → error, не виснет.
11. **transient recovery** — `503` затем `200` → успех в пределах cap.
12. **4xx no-retry** — `401` → 1 попытка, сообщение `HTTP 401` сохранено (для `classifyDiscoverError`).
13. **cursor cycle / maxRows overflow** — fail-closed, не ∞-loop / не рост памяти.
14. **Retry-After vs deadline** — `429` c `Retry-After: 60` при `operationDeadlineMs=30` → sleep ≤ остатка.

**Регрессии**: существующие data-api / rows-data-port зелёные; happy-path без изменений.
