# P2-5 + P2-6 + P2-7 — Queue reliability

Три дефекта устойчивости очереди/воркера из `CODE-REVIEW-2026-07-12.md`, объединённые в один PR
(общая тема — обслуживающие/recovery-пути, которые молча теряют работу или роняют процесс). Каждый —
отдельный TDD-коммит. Причина откладывания «за E4b» снята: дефекты выше P4 по риску, к промоушен-гейту
не привязаны.

Инвариант на весь PR: фичефлаги не трогаем (coalescing/dedup/notify остаются как есть), goldens
byte-identical, `result_hash` стабилен, гарантии heartbeat/shutdown из #137 сохраняются.

## P2-5 — Джоб застревает в `accepted`; replay прилипает к трупу

**Проблема.** `submitRun` (`jobs/submit.ts`) коммитит приём тремя отдельными стейтментами:
`insertOrGet(accepted)` → `appendEvent(job_accepted)` → `transition(accepted→queued)` → `appendEvent(job_queued)`.
Крэш процесса между `insertOrGet` и `transition` оставляет джоб в `accepted`. Репер (`reapDeadlines`)
expire'ит только `queued` за `queueDeadlineMs` (плюс `running`/`waiting_for_compute`), но НЕ `accepted` —
джоб застревает навсегда: воркер его не клеймит (не `queued`), publicStatus вечно показывает pending, а
`resumeToken`-retry (`findByResumeToken`) переприлипает к этому трупу.

**Фикс (ревьюер: «включить accepted за queue_deadline_ms в reap»).** `accepted` за `queueDeadlineMs`
терминализуется так же, как просроченный `queued` → `expired` (`queue_deadline_exceeded`). Строка попадает
в reaped → `reapAndPublish` публикует completion → владелец узнаёт. Терминальный replay возвращает
`expired`-хэндл (created:false), а не прилипает к non-terminal трупу.

- `queueDeadlineMs` уже проставляется в `accepted`-строке при `insertOrGet` (`now + queueTimeoutMs`), так что
  у репера есть дедлайн без изменения submit-пути.
- `ALLOWED_TRANSITIONS.accepted` расширяется `'expired'` (было `['queued','canceled']`). InMemory `transition`
  ходит через `canTransition`, поэтому без этого accepted→expired был бы отвергнут. Pg `reapDeadlines` — сырой
  UPDATE, машину состояний не дёргает, поэтому меняется только `WHERE status = 'queued'` → `IN ('queued','accepted')`.
- Порог тот же (`nowMs > queueDeadlineMs`), терминальный код тот же (`queue_deadline_exceeded`) — accepted и
  queued просрочки неотличимы для потребителя.

## P2-6 — Poison на wake-пути не эмитит completion-событие

**Проблема.** `wakeComputeWaiters` (`coalesce/wake.ts`) травит исчерпанных waiters через `poisonComputeWaiter`
(→ `failed(compute_wait_exhausted)`), но возвращает только счётчики `{released, poisoned}`.
`createCoalesceMaintenance` их выбрасывает (`() => Promise<void>`). В отличие от reaper-пути (poison внутри
`reapDeadlines` → reaped-строки → `reapAndPublish` публикует), wake-poison НЕ публикуется — владелец узнаёт
только поллингом.

**Фикс (ревьюер: «возвращать poisoned-строки из wake-шага и публиковать»).**

- `wakeComputeWaiters` дополнительно возвращает `poisonedJobs: JobRow[]` (счётчики `released`/`poisoned`
  сохранены — backward-compatible). Строку собираем ТОЛЬКО когда `poisonComputeWaiter` вернул `true` (выиграл
  CAS) — `await store.get(runId)` после успешного poison.
- `createCoalesceMaintenance` меняет сигнатуру `() => Promise<void>` → `() => Promise<JobRow[]>` (poisoned-строки
  этого прохода; пустой массив, если некого травить). Шаг остаётся «чистым» — publish-зависимостей у него нет,
  как и у `reapDeadlines`.
- Публикуют потребители, у которых есть `CompletionDeps`:
  - `app.ts::tick` (single-process): `for (const j of await coalesceMaintain()) await publishCompletion(completionDeps, j)`.
  - `worker.ts` beat (P3-4-таймер) и loop body (multi-process): то же, best-effort в beat.
- **Exactly-once (нет повторных terminal events).** `poisonComputeWaiter` — CAS (`waiting_for_compute → failed`,
  `rowCount === 1` только у победителя). Строку в `poisonedJobs` кладёт лишь победитель CAS, значит publish
  происходит ровно один раз независимо от того, сколько раз/из скольких мест вызван maintenance. Совпадает с
  дедуп-моделью reaper-пути (терминальную транзицию выигрывает один воркер).

## P2-7 — `tick` / `runWorkerLoop` без catch → unhandled rejection роняет процесс

**Проблема.**
- `app.ts`: `const tick = async () => { try {…} finally { busy=false } }` — БЕЗ `catch`; вызывается как
  `setInterval(() => void tick(), 200)` и `kick = () => void tick()`. Любая ошибка стора/вебхука = unhandled
  rejection → падение процесса.
- `worker.ts::runWorkerLoop`: тело `while` (drain/reap/deliverOutbox/coalesceMaintain/sweep/poll) без внутреннего
  `try/catch`. Транзиентная ошибка Pg в `claimNextQueued`/`get` пробрасывается наружу → `runWorkerLoop`
  реджектится → `worker-main` падает `exit(1)`, убивая sibling-прогоны на том же процессе.

**Фикс (ревьюер: «catch-and-log в tick, catch+backoff вокруг тела loop»).**
- `app.ts::tick`: добавить `catch` (лог, не ре-throw). `void tick()` становится безопасным; `busy` по-прежнему
  сбрасывается в `finally`.
- `worker.ts::runWorkerLoop`: обернуть per-iteration работу в `try/catch` с ограниченным abort-прерываемым
  backoff. Транзиентная ошибка → лог + backoff, БЕЗ ре-throw. Backoff экспоненциальный с потолком, сбрасывается
  после успешной итерации.

**Закреплённые инварианты P2-7 (обязательно тестами):**
1. **abort завершает loop без backoff.** В `catch` первым делом `if (signal.aborted) break;` — при shutdown во
   время ошибочной итерации loop резолвится сразу, backoff не спим.
2. **transient store error не убивает процесс.** Одноразовая ошибка `claimNextQueued`/`get` ловится, loop
   продолжает следующую итерацию (не реджектится); `runWorkerLoop`-промис не отклоняется.
3. **backoff ограничен, не hot loop.** Экспонента с потолком (`errorBackoffBaseMs`..`errorBackoffMaxMs`); при
   устойчивой ошибке число итераций в окне ограничено (нет busy-spin), abort прерывает сон немедленно.
4. **ошибка итерации не отменяет heartbeat/shutdown из #137.** `beat` (`setInterval`) продолжает renew/reap
   независимо; `finally { clearInterval(beat); await activeBeat }` по-прежнему дожидается живого beat.
5. **ошибки публикации не создают повторных terminal events.** `publishCompletion`/`deliverOutbox` в теле
   ловятся тем же `try/catch`; повторная итерация не публикует терминал повторно, т.к. терминальная строка уже
   не возвращается reap/poison (CAS/`SKIP LOCKED`), а `markDelivered(false)` лишь ставит outbox в retry.

Backoff — новые опции `runWorkerLoop` (`errorBackoffBaseMs`, `errorBackoffMaxMs`) с дефолтами; wire из
`config` в `worker-main` (новые `workerErrorBackoff*Ms`). Тесты задают маленькие значения для детерминизма.

## Инварианты (весь PR)

- **Byte-identical goldens / result_hash.** Ни один фикс не трогает движок/математику: P2-5 — только recovery
  просроченного приёма; P2-6 — только публикация уже-терминального poison; P2-7 — только обёртки ошибок.
- **INV-6.** Coalescing-пути (wake/poison/lock) остаются гейтед на `coalesceEnabled`; при OFF beat и тело
  идентичны прежним, P2-6 публиковать нечего.
- **#137.** heartbeat-таймер, `activeBeat`-shutdown и P3-5 eager-renew не меняются; P2-7 backoff живёт только в
  теле loop, не в beat.
- **Single-process ≠ multi-process.** `buildApp.tick()` детерминированных тестов трогаем только точечно
  (catch + publish poisoned); `runWorkerLoop` — отдельный путь.

## Тесты (TDD, по коммиту)

**P2-5** (Docker-free InMemory + Pg-gated зеркало):
1. accepted за `queueDeadlineMs` → `reapDeadlines`/`reapAndPublish` терминализует `expired`
   (`queue_deadline_exceeded`) + публикует completion. RED: accepted остаётся accepted. GREEN: expired.
2. accepted ДО дедлайна не трогается (не over-reap).
3. `resumeToken`-replay после reap возвращает terminal (expired) хэндл, а не прилипает к non-terminal.

**P2-6** (Docker-free InMemory, end-to-end через `runWorkerLoop` с зависшим drain — как #137):
4. Припаркованный исчерпанный follower (`computeWaitAttempts >= max`, callbackUrl, без cache-hit) → beat's
   `coalesceMaintain` травит и ПУБЛИКУЕТ `run_failed`/`compute_wait_exhausted` (webhook доставлен). RED:
   maintenance ничего не публикует → webhook не пришёл. GREEN: пришёл.
5. `wakeComputeWaiters` возвращает `poisonedJobs` только для CAS-победителя (exactly-once).

**P2-7** (Docker-free InMemory):
6. transient `claimNextQueued`-ошибка (бросить один раз) → loop не реджектится, следующая итерация клеймит
   нормально. RED: loop реджектится. GREEN: продолжает.
7. abort во время ошибочной итерации → loop резолвится без backoff-задержки.
8. устойчивая ошибка → backoff ограничен (итераций в окне ≤ N, не busy-spin) и abort прерывает сон.
9. ошибочная итерация не мешает beat renew'ить лизу (heartbeat из #137 жив) и shutdown ждёт `activeBeat`.
10. `app.ts::tick` бросок внутри drain/reap → `void tick()` не даёт unhandled rejection; `busy` сброшен.

**Регрессии**: worker-loop / reap / coalesce-wake / idempotency зелёные; INV-6 OFF-путь byte-identical.
