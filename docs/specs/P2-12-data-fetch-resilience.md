# P2-12 — Data-fetch resilience: timeout, bounded retry, pagination guards

Из `CODE-REVIEW-2026-07-12.md` P2-12. Два ownership-контура, одна спека, два TDD-слайса/коммита (сначала
service data-port, затем публичный SDK-клиент + release):

1. **Backtester `HttpDataPort`** (`apps/backtester/src/data/http-data-port.ts`) — per-request timeout,
   bounded retry, cursor-cycle detection, max pages/rows.
2. **SDK `BacktesterClient`** (`packages/sdk/src/client/client.ts`) — additive timeout/abort API + те же
   bounded-pagination гарантии (retry там уже есть — доводим, не переписываем).

## Проблема

- `HttpDataPort`: `listDatasets`/`openDataset`/`queryRange` зовут `fetch` **без** `AbortController` —
  зависший ответ платформы блокирует claiming-воркер навсегда (`runTimeoutMs` — концепт репера дедлайнов,
  не abort in-flight fetch). `queryRange` — `for(;;)` по `cursor`, выходит только на falsy `nextCursor`:
  upstream, вечно эхоящий тот же курсор, даёт бесконечный fetch-loop, а `materialize()` (аккумулирует ВСЕ
  строки в `Map<symbol, ReaderRow[]>`) растёт без границы → OOM. Ошибки — generic `throw new Error(...)`,
  не мапятся в data-taxonomy.
- `BacktesterClient`: retry реализован (idempotency-gating GET/resumeToken; 429 всегда, 5xx idempotent;
  expo backoff + full jitter; Retry-After honored+clamped; typed `Backtester*Error`), **но** каждый
  `fetchImpl(...)` — без timeout/abort. Hung fetch → retry-loop не двигается (attempt никогда не
  завершается). `FetchLikeInit` не несёт `signal`, caller не может отменить.

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

## Контур 2 — SDK `BacktesterClient` (additive)

- `FetchLikeInit` += `signal?: AbortSignal` (additive; фейки без него работают).
- Новая опция `BacktesterClientOptions.timeoutMs` (per-request) + `RetryOptions` уважает её; опциональный
  `deadlineMs` (operation). Каждый attempt оборачивается per-request `AbortController` + timeout; caller
  может передать свой `signal` (через новый `RequestOptions`/per-call arg) — его abort приоритетен и
  no-retry.
- Retry-set довести до правил: idempotent → retry на сети/`408`/`429`/весь `5xx` (сейчас 429+502/503/504);
  `4xx≠408/429` — no-retry (уже так через `raise`). `AbortError` (timeout) — transient (retry); caller-abort —
  raise немедленно.
- Bounded-пагинация: у SDK нет cursor-loop (только `awaitCompletion`, уже timeout-bounded; `readArtifact` —
  offset/limit одиночный). Гарантия = timeout/abort на каждом запросе + сохранение bounded `awaitCompletion`.
  Если/когда добавится cursor-метод — те же `maxPages`/`maxRows`/cycle-guard (вынести helper).
- **Публичный `.d.ts` без Node-globals** (только clean-consumer gate ловит; `AbortSignal`/`AbortController` —
  DOM/WHATWG-глобалы, доступны в lib.dom/webworker; проверить, что `tsc` public-типов чист).
- **Release implications.** Additive minor. Бамп версии = 4 сайта (`package.json` + `src/internal/versions.ts`
  `SDK_VERSION` + `package-shape.test` + `registry-contract.test`); релиз-workflow ассертит
  `package.json == input` → бамп+мерж ДО dispatch. Слайс 2 подготавливает изменения; сам релиз
  (`SDK Release` workflow_dispatch) — отдельным действием после мержа, по решению заказчика.

## Инварианты

- Happy-path результат не меняется (goldens/`result_hash` не затронуты — это транспортный слой, не движок).
- Дефолты консервативны: границы срабатывают только на реальном сбое/зависании/зацикливании.
- `HttpDataPort` — единственный http-путь; `RowsDataPort` (`real`) / `MockPlatformDataPort` / `FixtureDataPort`
  не трогаем в этом слайсе (у них своя семантика; при желании — отдельный fast-follow).

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

**Слайс 2 — `BacktesterClient`** (инъекция `fetchImpl` + `sleepImpl`):
10. **hanging fetch** — attempt-timeout → transient retry → (idempotent GET) recovery / (исчерпан) raise.
11. **abort priority** — caller `signal` abort → немедленно, no-retry.
12. **retry-set** — `408`/`429`/`5xx` idempotent → retry; `400`/`404`/`409` → no-retry (typed error).
13. **release-shape** — версия SDK забамплена во всех 4 сайтах; public `.d.ts` без Node-globals (gate).

**Регрессии**: существующие data-api / rows-data-port / sdk-client-retry зелёные; happy-path без изменений.
