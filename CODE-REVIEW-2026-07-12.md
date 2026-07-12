# Code Review — backtester

**Дата:** 2026-07-12
**Скоуп:** весь `apps/backtester/src/` + `packages/{sdk,research-contracts}`. Only-report, код не менялся.
**Метод:** графовый аудит Gortex (циклы/dead-code/дубли/флаги/контракты) + 6 параллельных read-only ревью-агентов по подсистемам (engine core, jobs/queue, sandbox/IPC, API/data, evidence/determinism, SDK). Флагманские P0/P1 верифицированы чтением исходников.

---

## TL;DR

Кодовая база в целом здоровая: **0 циклов зависимостей, 0 протухших фич-флагов, 0 мёртвых дублей**, dead-code — только намеренные type-assert'ы. Ядро движка (fill-модели, look-ahead, money-math на decimal.js, детерминизм, канонизация/подпись evidence, DSR-математика) написано аккуратно и хорошо защищено fail-closed'ами.

Но есть **один подтверждённый P0** (тихое отравление dedup-кэша при крэше sandbox) и группа P1, концентрирующихся в двух местах: **надёжность очереди/воркеров** (обработка ошибок процесса, ретраи вебхуков, застревание в coalescing) и **периметр безопасности HTTP-API** (SSRF через `callbackUrl`, дефолтный auth-токен, отсутствие таймаутов на fetch данных). Плюс сквозной баг, найденный независимо **тремя** агентами: `curatedBaselineRef` не входит в fingerprint.

Приоритет исправления: **P0-1 → P1-1/P1-2 (устойчивость воркера) → P1-6 (SSRF) → P0/P1 sandbox-IPC перед включением `BACKTESTER_BAR_BATCHING` → сквозной `curatedBaselineRef`**.

---

## P0 — подтверждённый баг, повреждающий результаты

### P0-1. Крэш sandbox финализирует прогон как `completed` и **отравляет dedup-кэш**
**Файлы:** `apps/backtester/src/jobs/worker.ts` (пути overlay ~585 / strategy ~607, запись в кэш 685–688), корень в `apps/backtester/src/engine/sandbox/sandbox-executor.ts` и `.../routing.ts`.

Sandbox-executor намеренно деградирует любой сбой хука до `{kind:'idle'}` / пустых решений и лишь **записывает** `SandboxErrorArtifact`. Единственный потребитель `router.errors()` во всём `src/` — guard H1 в evidence-драйвере (`strategy-evidence-driver.ts:137`), добавленный ровно потому, что «иначе крэш sandbox тихо даёт 0 трейдов». В **production-пути воркера этого guard'а нет** (проверено: `grep router.errors` по `worker.ts` пусто). Последствия при OOM/крэше контейнера в середине прогона:

1. Терминальный `completed`-джоб с трейдами, обрезанными с бара крэша, и валидным `resultHash`.
2. Хуже: деградированный payload пишется в `resultCache.put` (для обычных bundle-прогонов `dedupOn === true`) → каждый последующий идентичный запрос получает **HIT на отравленный шаблон**. Коррупция становится постоянной и невидимой.
3. В evidence-блоке крэш всплывает лишь как непрозрачное equivalence-расхождение — тот самый режим, для дизамбигуации которого и существует H1.

**Фикс:** после `runOverlayBacktest`/`runStrategyBacktest` (до `finalizeResult` и до `put`), если `sandboxRouter` есть — проверять `sandboxRouter.errors()` и бросать `RunnerError('sandbox_error', …)`, зеркаля guard H1 драйвера.

---

## P1 — вероятные баги (production-relevant)

### P1-1. Нет `pool.on('error')` — падение idle-клиента pg роняет весь процесс
**Файл:** `apps/backtester/src/app.ts:84` (создание `ownedPool`), `apps/backtester/src/db/pool.ts` (`createPool`). Проверено: ни одного `pool.on('error')` в `src/`.

node-pg эмитит `'error'` на idle-клиентах при рестарте Pg / обрыве сети / failover. Неперехваченный `'error'` на EventEmitter = uncaught exception → падает весь воркер (и in-flight sibling-слоты); на API-ноде убивает и HTTP. Лизы восстановят джобы, но **любой сетевой blip превращается в crash-restart всего флота**.
**Фикс:** `pool.on('error', log)` в `createPool`/`buildApp`.

### P1-2. В multi-process топологии вебхуки не ретраятся вообще
**Файлы:** `app.ts:198-232` (`tick`→`deliverOutbox`), `index.ts:9` (tick стартует только при `autoWorker`), `jobs/worker.ts:785+` (`runWorkerLoop`).

`deliverOutbox` достижим только через `tick()`, а таймер тика включается лишь при `BACKTESTER_AUTO_WORKER=true`. В штатной multi-process схеме (API-нода с `autoWorker=false` + флот `worker-main`) `runWorkerLoop` делает drain+reap+wake, но **никогда не флашит outbox**, а API-нода не тикает. Вебхук, упавший один раз (помечен `failed` в `completion.ts:79`), больше не ретраится — «layer-2 redelivery» из докстринга `completion.ts` в топологии-для-масштаба фактически не существует.
**Фикс:** вызывать `deliverOutbox` в worker-loop или по периодическому таймеру на API-ноде независимо от `autoWorker`.

### P1-3. Откат флага coalescing навсегда застревает followers в `waiting_for_compute`
**Файлы:** `worker.ts:826` и `app.ts` tick (`wakeComputeWaiters` — всё под флагом), `pg-job-store.ts:388-471` (репер трогает только `queued`/`running`), `lifecycle.ts` (нет перехода `waiting_for_compute → timed_out`).

Followers будятся только через `wakeComputeWaiters`, все вызовы флаг-гейтед. Репер `run_deadline` матчит `status='running'`, поэтому строки `waiting_for_compute` ему невидимы. Сценарий: coalescing включён, followers припаркованы, флаг откатывают (штатная цель kill-switch dark-launch) → строки застревают навечно, `publicStatus` вечно отдаёт клиенту `running`.
**Фикс:** репер должен обрабатывать `waiting_for_compute` за `run_deadline_ms` **безусловно** (независимо от флага) + разрешить переход `waiting_for_compute → timed_out`.

### P1-4. IPC-канал sandbox делит stdin/stdout с untrusted-кодом; нет корреляции по `seq`
**Файлы:** `sandbox-harness-overlay/entry.mjs:30`, `engine/sandbox/async-ipc-channel.ts` (`seq` парсится, но `receive()` его не проверяет), `worker.ts:611` (barBatching → `callHookBatch`).

Harness пишет NDJSON-ответы в `process.stdout` и читает запросы из `process.stdin`, оба разделяются с импортированным untrusted-бандлом; хост коррелирует ответы **только по порядку прибытия**, никогда по `seq`. Следствия (внутри собственного прогона модуля — из контейнера он не выходит, но целостность IPC/результата ломается):
- `console.log`/`stdout.write` из бандла впрыскивает строку → `sandbox_output_malformed` → сессия умирает, остаток баров тихо деградирует до baseline.
- Бандл может подделать `{"t":"ok","seq":…,"decisions":[…]}` раньше настоящего ответа — без проверки `seq` хост съедает подделку, реальные ответы десинхронизируются на бар.
- **Острый край — lookahead в batch-режиме:** `callHookBatch` шлёт `maxBars` (деф. 64) *будущих* баров одним `hookBatch`-конвертом. Бандл может повесить свой `process.stdin.on('data')` и прочитать будущие бары до вызова `onBarClose` — структурное нарушение no-lookahead, существующее только в batch-режиме. На strategy-пути это питает `produceStrategyEvidence` → подглядывающая стратегия даёт завышенные метрики, которые затем **подписываются Ed25519** для admission. Гейт `BACKTESTER_BAR_BATCHING` по умолчанию OFF (потому P1, не P0).

**Фикс:** (1) валидировать `outcome.seq === this.seq`, mismatch = fatal; (2) в harness захватить реальный stdout-handle на старте и заменить `process.stdout.write`/`console.*` для untrusted-модуля на no-op/stderr, читать stdin через приватный handle; (3) **не** отправлять будущие бары одним конвертом, пока stdin разделяется. Обязательно закрыть до включения `BAR_BATCHING` на любом evidence-прогоне.

### P1-5. Дрейф валидации путей бандла между SDK-preflight и сервером
**Файлы:** `packages/sdk/src/builder/preflight.ts:24-34` (`isUnsafePath`, segment-exact `.`/`..`) vs `apps/backtester/src/sandbox/bundle.ts:46` (substring `key.includes('..') || key.startsWith('/')`).

Валидаторы расходятся в обе стороны. Файл `lib/a..b.js` проходит preflight (`accepted`), но сервер возвращает 400 `bundle_invalid` — вся суть «authoritative-compatible» preflight'а нарушена. И наоборот, ключи `a\b`, `C:x`, `./x`, `a\0b` и любой небезопасный `entry` (сервер не path-чекает `entry`, только membership) проходят сервер, но валятся в SDK.
**Фикс:** вынести `isUnsafePath` в общий предикат и импортировать его в `sandbox/bundle.ts` — один источник истины на обеих сторонах.

### P1-6. SSRF через невалидированный `callbackUrl`
**Файлы:** `jobs/submit.ts` (`validate()` не проверяет `callbackUrl`, копирует его в `NewJob` на стр. 207), `jobs/completion.ts:33-48` (`defaultWebhookPoster` делает `fetch(url, {method:'POST'})`).

Клиент шлёт `callbackUrl: "http://169.254.169.254/latest/meta-data/…"` или `http://127.0.0.1:<internal-port>/…`. На завершении джоба сервер делает запрос, управляемый атакующим, **изнутри trust boundary** — классический blind/semi-blind SSRF (скан внутренних портов по latency/статусу, зондирование cloud-metadata).
**Фикс:** валидировать `callbackUrl` на submit — требовать `https:` (или allowlist схем), отклонять хосты в private/link-local/loopback диапазонах (или allowlist хостов оператора), 400 вместо тихого дропа. Таймаут 10s уже есть.

---

## P2 — подтверждённые gap'ы / узкотриггерные баги

### Сквозной баг (найден независимо 3 агентами)
### P2-1. `curatedBaselineRef` не входит в request fingerprint
**Файл:** `jobs/fingerprint.ts:16-33` (`normalize` его пропускает), `jobs/submit.ts` (`assertReplayFingerprint`), использование в `worker.ts:627-631`.

`resumeToken`-replay, который добавляет/меняет/убирает `curatedBaselineRef`, проходит `assertReplayFingerprint` без 409 и тихо переприлипает к старому джобу. Клиент считает, что evidence-прогон принят, а evidence либо не будет создан, либо подписан против **старого** baseline. Dedup сам по себе безопасен (evidence-прогоны минуют кэш), проблема именно в replay-контракте.
**Фикс:** добавить `curatedBaselineRef: req.curatedBaselineRef ?? null` в `normalize` (поле и так вне 017-валидатора, включение в fingerprint безопасно; скоординировать с `computeVersion` dedup-кэша).

### Очередь / воркеры
- **P2-2. Дубли терминальных completion-событий (гонка воркер/репер).** `worker.ts:747,772` — `processNextQueued` игнорит булев результат терминального `transition` и безусловно публикует то, что вернул `get(runId)`. При истечении `run_deadline` в середине движка другой воркер репером помечает `timed_out` и публикует событие; оригинал по проваленному CAS перечитывает строку, видит терминальный `timed_out` и публикует **второе** `job_timed_out` с новым `eventUid` (дедуп по `event_uid` не спасает) → дубли в outbox и дубли вебхук-POST. Фикс: публиковать только если собственный `transition` вернул `true`.
- **P2-3. Вечный retry-loop через `engine_attempt_charged`.** Оба пути requeue репера (`pg-job-store.ts:424,454`) не сбрасывают `engine_attempt_charged=false` (в отличие от `releaseAllComputeWaiters`/`electOneComputeWaiter`). Джоб, доходящий до движка один раз и затем крэшащий процесс до `chargeEngineAttempt` (напр. OOM в `materializeFor` на холодном кэше), никогда не двигает `attempts` → бесконечный requeue процессо-убивающего джоба. Зеркалится в `InMemoryJobStore`. Фикс: сбрасывать `engine_attempt_charged=false` в обоих UPDATE (или инкрементить `attempts` на requeue).
- **P2-4. Advisory-подсистемы на критическом пути валят успешный прогон.** `worker.ts:687-688` — populate dedup (`artifactStore.write` + `resultCache.put`) без guard'а после успеха движка; сбой кэша/стора → catch помечает джоб `failed(runner_failure)`, результат движка выброшен. `worker.ts:243` — `recordTrialAndComputeContext` в `finalizeResult` без try/catch: ошибка вставки в trial-ledger валит прогон, хотя фича «advisory, never hashed». Фикс: обернуть оба в best-effort try/catch.
- **P2-5. Джоб застревает в `accepted`; replay прилипает к трупу.** `submit.ts:214-222` — insertOrGet(`accepted`)→appendEvent→transition отдельными стейтментами; крэш между ними оставляет `accepted`, а репер expire'ит только `queued`. `resumeToken`-retry переприлипает к застрявшему. Фикс: включить `accepted` за `queue_deadline_ms` в reap (или вставлять сразу `queued`).
- **P2-6. Poison на wake-пути не эмитит completion-событие.** `coalesce/wake.ts:43`→`poisonComputeWaiter` переводит waiter в `failed(compute_wait_exhausted)`, но никто не публикует (в отличие от reaper-пути) — владелец узнаёт только поллингом. Фикс: возвращать poisoned-строки из wake-шага и публиковать.
- **P2-7. `void tick()` / `runWorkerLoop` без catch → unhandled rejection роняет процесс.** `app.ts:200-219` — `try/finally` без `catch`, вызывается как `void tick()`; любая ошибка стора/вебхука = unhandled rejection → exit. `runWorkerLoop` тоже без внутреннего catch: транзиентная ошибка Pg в `claimNextQueued`/`get` пробрасывается наружу → `worker-main` exit(1), убивая sibling-прогоны. Фикс: catch-and-log в `tick`, catch+backoff вокруг тела loop.
- **P2-8. Параллельный `migrate()` на M воркерах без сериализации.** `db/migrate.ts` без advisory-lock; каждый `worker-main` мигрирует на старте. Два одновременных старта на свежей БД применяют один файл дважды — `0006` (`DROP/ADD CONSTRAINT`) не идемпотентен, INSERT в `schema_migrations` конфликтит по PK → один воркер падает на boot. Rolling deploy может флапать. Фикс: `pg_advisory_lock` вокруг цикла миграций.
- **P2-9. Head-of-line starvation outbox + безлимитные ретраи вебхуков.** `pg-job-store.ts:373` `listDeliverable` отдаёт oldest-first `LIMIT n` по `pending|failed`; `completion.ts:124` `deliverOutbox` ретраит без cap/backoff (`delivery_attempts` инкрементится, но не читается). ≥50 событий на мёртвые URL занимают всю страницу навсегда, новые pending не пробуются. Фикс: cap `delivery_attempts` (терминальный fail после N) + сортировка по attempts/backoff.

### API / данные
- **P2-10. Auth-токен дефолтит в общеизвестное значение.** `config.ts` — `authToken: env.BACKTESTER_AUTH_TOKEN ?? 'dev-token'`, без fail-closed в prod (в отличие от `BACKTESTER_DATA_SOURCE=real`, который бросает при отсутствии токена). Незаданная env → API принимает `Bearer dev-token` на всех `/v1`. Фикс: fail-closed при пустом токене или отказ биндиться на non-loopback.
- **P2-11. Сравнение Bearer не constant-time.** `api/server.ts:59` и `data/data-api-server.ts:38` — plain `!==`. Фикс: `crypto.timingSafeEqual` над хэшами фикс-длины.
- **P2-12. Нет таймаута/ретрая на historical data-port; безлимитная пагинация.** `data/http-data-port.ts` (`queryRange`/`listDatasets`/`openDataset`) и SDK `HistoricalClient` вызывают `fetch` **без** AbortController. Зависший ответ платформы блокирует claiming-воркер навсегда (`runTimeoutMs` — концепт репера дедлайнов, не abort in-flight fetch). Оба paging-цикла `for(;;)` выходят только на falsy `nextCursor` — upstream, вечно эхоящий курсор, даёт бесконечный fetch-loop + рост памяти в `materialize()`. Фикс: per-request таймаут (AbortController) + bounded retry/backoff + max-page/max-row guard.
- **P2-13. `periodMs` тихо коэрсит непарсимый/инвертированный диапазон дат.** `worker.ts:120-129` — непарсимые `from`/`to` → `0`/`MAX_SAFE_INTEGER` (полный диапазон), а `data-adapter.ts:70-77` на том же входе корректно бросает `validation_error`. `submit.ts:67` проверяет только тип `string`, не парсимость и не `from < to`. Momentum-прогон с `from="not-a-date"` тихо бежит по всему датасету; **на strategy-evidence пути подписывается body с `window={0, 9007199254740991}`** — scope-заявление, не связанное с запросом. Фикс: валидировать `Date.parse` + `from < to` в `submit.ts::validate()`, `periodMs` должен бросать.
- **P2-14. Элементы `symbols` не валидируются; CSV wire-injection.** `submit.ts::validate()` проверяет лишь `Array.isArray && length>0`; элементы уходят в upstream как `symbols.join(',')`. Символ с `,` расщепляется на два на проводе; массив без cap → произвольно большой upstream-fetch. Фикс: требовать непустую строку из разрешённого charset (без запятых/пробелов) + глобальный max symbol count.
- **P2-15. 500-ответы отдают сырой `error.message`.** `api/server.ts:47-52` — неожиданные throw возвращают сырое сообщение (внутренние пути, dataset-ref, детали зависимостей). Фикс: для неклассифицированных 500 — generic message + correlation id, детали в лог (есть `boundedErrorDetail`).

### Sandbox
- **P2-16. Per-call дедлайн применён ко всему batch/bar-major конверту.** `sandbox-session.ts` — `callHookBatch`/`callHookBarMajor` ждут `channel.receive(this.callDeadline())`, где дедлайн = 2000 ms на *весь* конверт (до 64 баров / N символов). Включение batching тихо сжимает бюджет с 2s до ~2s÷64 (~31 ms/бар) → спурьёзный `sandbox_timeout` и дивергенция режимов. Фикс: масштабировать дедлайн на число записей в конверте.
- **P2-17. Незапиненный образ на momentum-пути.** `sandbox/docker.ts:30` — `image='node:24-alpine'` (мутабельный тег), тогда как overlay/strategy пинится по digest (`sandbox-policy.ts`). Supply-chain surface + gap детерминизма. Фикс: пинить по digest из той же policy-константы.
- **P2-18. Жёсткий крэш воркера осиротит детерминированно-именованный контейнер; нет reaper'а.** `docker-driver.ts` — имя контейнера детерминировано (`sbx-<runId>-…`), teardown только в `close()`. `SIGKILL` до `close()` оставляет контейнер; requeue того же `runId` делает `docker run --name <same>` → «name already in use» → open падает, сессия удаляет орфана, и лишь **следующий** requeue успешен — один прогон сожжён. Фикс: startup/периодический sweep stale `sbx-*` по label, или `docker rm -f` целевого имени перед `run`.

### Engine
- **P2-19. Funding-начисление ломается на тейпах с пропусками минут.** `engine/runner.ts:518` — `gridMinutes` выводится из первых двух баров и применяется ко всему прогону. Пропущенная 2-я минута → `gridMinutes=2` → каждый бар заряжается 2× funding (equity/pnl/sharpe/ledger неверны). Пропуски в середине при удерживаемой позиции → **нулевой** charge за gap — систематический недочёт на реальных canonical-данных (в которых минуты пропадают). Фикс: заряжать per-bar минуты из фактической дельты `ts[t]-ts[t-1]` с явной политикой на gap-интервалы, никогда не экстраполировать первый интервал.
- **P2-20. Утечка состояния stateful-модуля без `moduleFactory`.** `runner.ts:656-663` (symbol-major) и `:714-716` (bar-major) — без фабрики один и тот же объект `module` переиспользуется для всех символов. Symbol-major кормит его последовательно (state символа 1 сидит символ 2); bar-major интерливит все символы через одно замыкание. Следствие: sandbox-twin (per-symbol сессии) vs trusted расходятся, а флип `barMajor` меняет результат — ломает премису «byte-identical per symbol», на которой стоит корректность Slice A/B. Фикс: fail-fast (требовать фабрику при N>1 stateful-модуле).

### Evidence
- **P2-21. Scope-окно подписи деградирует в `[0, MAX_SAFE_INTEGER]` на непарсимом периоде.** Тот же корень, что P2-13; интеграл-релевантная часть — **подписывается** body с scope, не связанным с запросом. Фикс: как P2-13.
- **P2-22. Evidence-путь пере-хэширует байты с диска, а не lab-pinned raw-байты.** `worker.ts:636` — `readFileSync(join(bundleDir, entryPoint))`, тогда как драйвер (guard H2) требует хэшировать lab-pinned raw-байты. Сегодня совпадает, но любой будущий materialization-transform (нормализация EOL, banner) тихо подпишет `bundleHash`, не совпадающий с pinned → admission fail-closed без локального сигнала. Фикс: прокидывать raw-байты `files[entry]` из хранимого `ModuleBundle`.
- **P2-23. `exportSignerPublicKey` тихо генерит эфемерный ключ без PEM.** `evidence/export-signer-pubkey.ts:13-16` — оператор без env/arg получает правдоподобный `{keyId, publicKeyPem}`, который никогда не совпадёт с будущей подписью (ровно инцидент со stale `signer.pub.json` из заметок проекта). Сам signing-путь безопасен (нет ключа ⇒ signing OFF). Фикс: требовать PEM или гейт `--generate`.

### SDK
- **P2-24. Импорт SDK глобально меняет rounding mode decimal.js.** `packages/sdk/src/internal/canonical-json.ts:11` — `Decimal.set({rounding: ROUND_HALF_EVEN})` на загрузке модуля; `decimal.js` — реальная runtime-зависимость, дедуп у консьюмера флипнет его дефолтный `ROUND_HALF_UP`. SDK глобал даже не нужен (`quantizeToString` передаёт mode явно). Фикс: `Decimal.clone(...)` или убрать `Decimal.set`.
- **P2-25. Kernel-бандлинг работает случайно — `noExternal` regex указывает на неверный пакет.** `packages/sdk/tsup.config.ts:20` — `noExternal: [/^@trading-platform\/sdk/]`, но kernel — `@trdlabs/sdk`. Бандлится сейчас только потому, что `@trdlabs/sdk` в `devDependencies`. Перенос его в `dependencies` (естественный «cleanup») → tsup экстернализует → публикуется неразрешимый импорт (ровно break из памяти `sdk-self-contained-packaging`). Фикс: `/^@trdlabs\/sdk/`.
- **P2-26. Нет таймаута/abort в `BacktesterClient`.** `packages/sdk/src/client/client.ts:44-48,150` — `FetchLikeInit` без `signal`, `fetchImpl` без дедлайна; `awaitCompletion.timeoutMs` проверяется только *между* поллами. Зависший коннект блокирует `submitRun`/`getRunStatus` навсегда, ретраи не спасают. Фикс: опциональный per-request `timeoutMs` через AbortController.
- **P2-27. `entry in files` ходит по прототипу.** `preflight.ts:118` и `sandbox/bundle.ts:50` — `!(b.entry in b.files)`; `entry:'toString'` (или `constructor`) без такого ключа проходит оба валидатора, падает криптично при materialization. Фикс: `Object.hasOwn(b.files, b.entry)` на обеих сторонах.

---

## P3 — производительность / harden

- **P3-1. O(n²) построение market-API на каждом баре — доминирующий CPU-кост на market-tape прогонах.** `engine/context.ts:104` зовёт `pointInTimeMarketApi(...)` на **каждом** баре; та (`market-access.ts:64-65`) делает `dataset.candles(symbol).map(b=>b.ts)` (свежий O(n) массив/бар) + `gridTs.indexOf(t)` (O(n) скан/бар). 30-дневный 1m-прогон (~43k баров) → ~2×10⁹ сравнений + 43k аллокаций 43k-массивов на символ на target. Активно всегда, когда тейп несёт OI/liq/funding/taker (т.е. каждый реальный `long_oi`-прогон). **Фикс: hoist `gridTs` в `PointInTimeContextBuilder` (раз на символ) + передавать `barIndex`** — как уже корректно сделано в funding-пути `buildBarEnv`. Дешёвая крупная победа.
- **P3-2. deny-shim может не покрывать ESM named-импорты.** `deny-shims.mjs` патчит `require('node:child_process').<m>`, но не зовёт `module.syncBuiltinESMExports()` — `import { spawn } from 'node:child_process'` может резолвнуть оригинал. Реальный барьер — контейнер (net=none, cap-drop ALL, pids-limit); shim слабее, чем выглядит. Фикс: `syncBuiltinESMExports()` после патча.
- **P3-3. Дефолтный cumulative stdout-cap (64 KiB) валит длинные легитимные прогоны.** `async-ipc-channel.ts` (`stdoutTotal` накапливается на всю сессию) + `sandbox-policy.ts` `maxStdoutBytes=65536`. Длинная стратегия, эмитящая decisions каждый бар, триггерит `sandbox_output_overflow` в середине → сессия умирает. Фикс: подбирать policy по длине прогона или ввести per-message cap вдобавок к cumulative.
- **P3-4. Reap/wake starvation под нагрузкой.** `runWorkerLoop` зовёт `reapAndPublish`/`wakeComputeWaiters` только после полного drain; при устойчивом входе воркеры вечно в drain → крэшнутые джобы (истёкшие лизы) и припаркованные followers ждут произвольно долго. Фикс: репить по heartbeat-таймеру.
- **P3-5. Heartbeat на event-loop.** `worker.ts` `setInterval`-beat: синхронная секция дольше `workerLeaseTtlMs` (CPU-bound momentum, sync materialization) голодит обновление → спурьёзное истечение лизы → двойное исполнение движка (терминальный CAS от double-commit спасает, но работа + charge сожжены). Фикс: heartbeat вне синхронного пути.
- **P3-6. Безлимитный рост `backtest_result_cache` / `backtest_compute_lock` / `backtest_job_event`.** Нет TTL/eviction; success-путь не удаляет compute-lock (ждёт TTL). Фикс: TTL/эвикция.
- **P3-7. `cagr`/`calmar` считают по запрошенному периоду, не по обработанным барам.** `runner.ts` `elapsedYearsOf(request.period)` — при частичном покрытии (не reject) CAGR/Calmar занижены; питает qualification-поверхности. Фикс: считать elapsed years из first/last обработанного бара.
- **P3-8. Безлимитный `bundleCache` в SDK-клиенте.** `client.ts:116,222` — каждый `putBundle` держит полные байты навсегда. Фикс: небольшой LRU.
- **P3-9. Init-сбой универс-сессии фатален для всех символов.** `sandbox-session.ts` `ensureSymbolInit` на non-ok зовёт `fail()` (закрывает общий контейнер), тогда как per-hook сбой soft-latch'ит один символ. Фикс: soft-latch символа и на init-сбое.

---

## P4 — мелочи

- **`splitWalkForward` допускает нулевую ширину фолда** (`walk-forward.ts:36-66`): при span (ms) < `folds+1` границы совпадают, `test.from===test.to`. Добавить guard до старта E3b.
- **`computeReturnsStats` обнуляет всю серию из-за одной equity-точки ровно `0`** (`metrics.ts:123`): включая `returns_count`, что DSR (E2) трактует как «нет данных» — обнулённый счёт парадоксально уходит от DSR-скрутини.
- **Ничья порядка Pg vs in-memory trial-ledger** (`pg-trial-ledger.ts:63` ORDER BY `created_at_ms`): ties → недетерминированный порядок → `sampleVariance` float-reduction различается (advisory, не хэшируется). Добавить `run_id`-tiebreaker.
- **`createModuleBundle` тихо теряет файл с ключом `__proto__`** (`packages/sdk/src/builder/bundle.ts:19`): присваивание на plain `{}` бьёт в setter прототипа → own-property не создаётся, контент и `computeInlineBundleHash` расходятся с инпутом автора (сервер через `JSON.parse` сохранил бы). Фикс: `Object.create(null)`.
- **Двойное сравнение токена / echo NaN в reference data-server** (`data-api-server.ts:59-64`): `Number(q.tsFrom ?? 0)` → `NaN` фильтрует всё → пустая 200 вместо 400. Dev-сервер, severity низкая.
- **Незащищённые env-числа** (`config.ts`): `port`, `defaultQueueTimeoutMs`, `defaultRunTimeoutMs`, `dataApiPageLimit` через bare `Number(env ?? default)` без `Number.isFinite` (в отличие от `workerConcurrency`/`batchBars`). Мусорный `BACKTESTER_QUEUE_TIMEOUT_MS` → `NaN` → джобы никогда не истекают.
- **Двойной SIGTERM/SIGINT** запускает `shutdown` дважды (`index.ts`, `worker-main.ts`) → второй `pool.end()` реджектит в `void`-промисе.
- **`.cursor/rules/gortex-communities.mdc`** ссылается на несуществующие skill-пути (config drift; `audit_agent_config`).
- **`mapFailure` в universe-режиме теряет `barIndex`** (`sandbox-session.ts`): читает скалярный `this.barIndex` (остаётся `-1`), а не per-symbol слот.

---

## Чистые области (проверено, действий не требуется)

- **Look-ahead в движке:** не найдено. Fill'ы строго на open(t+1)/close(t); protection интрабар с корректной gap-through базой и stop-first tiebreak; индикаторный движок видит [0..t] с fresh-replay для прошлых баров; `oiAsOf/liqAsOf/fundingAsOf/taker*` все ≤ t без forward-методов.
- **Money-math:** decimal.js везде, квантизация только на границе артефакта; slippage всегда adverse; funding не трогает per-trade PnL.
- **Канонизация/подпись evidence:** sorted keys рекурсивно, `-0→0`, non-finite бросает; abort-before-sign seam (gate→twin→status→verdict, единственный sign за `verdict==='passed'`); twin-equivalence реально byte-level с нулевым допуском, fail-closed; advisory-поля (`diagnostics`/`holdout`/`trialContext`) вне хэша.
- **Детерминизм:** нет `Date.now`/`Math.random`/ISO в хэшируемом контенте; порядок задаётся массивом `symbols`, не итерацией Map; нет зависимости от порядка `Promise.all`; seeded mulberry32.
- **DSR-математика** (`deflated-sharpe.ts`): соответствует Bailey & López de Prado, все guard'ы (T<2, non-finite моменты, non-positive denominator, N≤1 cold-start, degenerate V[SR]).
- **Claim-путь очереди:** CTE `FOR UPDATE SKIP LOCKED` одним стейтментом (нет окна double-claim); owner-guarded терминальный CAS. **SQL-инъекций нет** — всё параметризовано. Нет риска pool-deadlock (нет client, удерживаемого через await).
- **queue-notify.ts:** выделенный LISTEN-коннект, reentrancy-guarded backoff-reconnect, `pendingWake` закрывает окно lost-wakeup, поллинг как backstop.
- **Dedup- core:** `computeIdentity` инклюзивен (fingerprint ⊃ run-affecting + datasetFingerprint + policy + computeVersion); evidence-прогоны минуют lookup И populate; put first-writer-wins.
- **Docker-изоляция overlay-пути** (`buildDockerRunArgs`): `--network none`, `--read-only`, tmpfs `noexec,nosuid`, `--memory==--memory-swap`, `--cpus`, `--pids-limit`, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root `--user`, без `-e`, mounts `:ro`. EBADF-фикс держится (`stdin.destroy()` через stream, не `closeSync` raw-fd).
- **Path traversal бандла:** `validateBundle` + `assertSafeRelativePath` + `toMountSource` состоятельны.
- **bundle-by-ref — НЕ URL-fetch:** `bundleRef` = content-hash (`^sha256:[0-9a-f]{64}$`), резолвится по ключу в BundleStore — SSRF здесь нет (в отличие от `callbackUrl`).
- **SDK HTTP-core:** non-2xx никогда не трактуется как успех; `encodeURIComponent` на path-params; retry well-scoped (429 всегда; network/5xx только для идемпотентных); `unknown_bundle` self-heal bounded в один re-PUT.
- **Hash/fingerprint parity** SDK↔сервер — реально single-source (`determinism/*` = тонкие ре-экспорты SDK).

---

## Рекомендованный порядок работ

1. **P0-1** — guard `router.errors()` в воркере (отравление кэша — повреждение денег + персистентность). *Точечный фикс, зеркалит существующий H1.*
2. **P1-1, P1-2, P1-3, P2-7** — устойчивость воркера/очереди: `pool.on('error')`, флаш outbox в multi-process, безусловный reap `waiting_for_compute`, catch в `tick`/loop. *Дешёвые фиксы, снимают fleet-wide crash-restart и вечное застревание.*
3. **P1-6, P2-10, P2-12** — периметр API: SSRF `callbackUrl`, fail-closed auth-токен, таймауты на data-fetch. *Безопасность + защита воркер-слотов от зависания.*
4. **P1-4 + P2-16** — закрыть stdin-sharing и добавить `seq`-валидацию **до** включения `BACKTESTER_BAR_BATCHING` на любом evidence-прогоне.
5. **P2-1** — `curatedBaselineRef` в fingerprint (координировать с `computeVersion`).
6. **P3-1** — hoist `gridTs`/`barIndex` (крупная бесплатная победа по CPU на реальных прогонах).
7. Остальные P2/P3/P4 — по мере касания соответствующих модулей.
