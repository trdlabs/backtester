# P3-4 + P3-5 — reap/wake на heartbeat-таймере + lease-renew вне синхронного пути

Парный слайс (ревьюер: «логично парой»): оба дефекта в `runWorkerLoop` (`apps/backtester/src/jobs/worker.ts`),
оба — про то, что обслуживающая работа (reap/wake/lease-renew) сцеплена с drain-путём и голодает под нагрузкой.

## P3-4 — Reap/wake starvation под нагрузкой

**Проблема.** Тело loop'а: `drainQueue → reapAndPublish → deliverOutbox → coalesceMaintain → sweep → idle-wait`.
`drainQueue` (`runBoundedPool`) тянет `processNextQueued`, пока очередь не опустеет. При **устойчивом входе**
drain не возвращается никогда → `reapAndPublish`/`wakeComputeWaiters` (внутри `coalesceMaintain`) не вызываются →
крэшнутые джобы (истёкшие лизы) не реапятся, припаркованные followers ждут произвольно долго.

**Фикс (ревьюер: «репить по heartbeat-таймеру»).** Reap + wake теперь идут и на heartbeat-таймере, независимо
от завершения drain:

- Beat-callback (`setInterval`, `heartbeatMs`) кроме renew лизы/compute-lock’ов теперь делает
  `reapAndPublish` + `coalesceMaintain` (wake followers + throttled bounded lock sweep). Под бесконечным drain
  таймер — единственное, что реапит; он срабатывает, т.к. drain’ы — это awaited-async джобы (event-loop свободен
  между ними) и незавершённый await НЕ блокирует таймер.
- Тело loop’а СОХРАНЯЕТ post-drain `reapAndPublish`/`coalesceMaintain` — это prompt idle-путь (реап сразу как
  очередь опустела, не ждём до heartbeatMs). Таймер покрывает sustained-drain, тело — idle. Двойной вызов
  безопасен и идемпотентен: `reapDeadlines` — `FOR UPDATE SKIP LOCKED` (непересекающиеся строки), publish под
  `ownTerminalTransition`-гардом (P2-2, без дублей событий), sweep — throttled (не чаще cadence).
- **Re-entrancy guard**: флаг `beatInFlight` — если предыдущий tick ещё не дорезолвился (медленный reap/renew),
  следующий tick пропускается, а не стакается. `pendingRenew` (дожидается в `finally`) теперь трекает весь
  tick, чтобы ничего не реджектнулось после shutdown.
- `deliverOutbox` + `resultCacheSweep` остаются ТОЛЬКО в теле (не цель P3-4; outbox-тест зависит от cadence
  тела; sweep throttled и независим).

## P3-5 — Heartbeat на event-loop (**MITIGATED, не CLOSED**)

**Проблема.** Beat — `setInterval` на event-loop. Trusted momentum-путь (`runBacktest`): один `await
computeSignals`, затем **синхронный** `for` по символам с `simulateSymbol` (tight per-bar loop, БЕЗ `await`). На
большой вселенной/длинной 1m-ленте эта синхронная секция дольше `workerLeaseTtlMs` блокирует event-loop → beat
не может сработать → renew лизы голодает → спурьёзное истечение лизы → другой воркер реапит «истёкшую» джобу и
**повторно гоняет движок** (терминальный CAS от double-commit спасает корректность, но работа + charge сожжены).
Sandbox/strategy-путь идёт через async IPC (yield-ит), поэтому beat там срабатывает нормально — дефект
специфичен для trusted in-process momentum-пути (в основном внутренний smoke/baseline).

**Митигация (ревьюер: «heartbeat вне синхронного пути»).** В одном Node-потоке никакой таймер не сработает во
время синхронного блока — поэтому renew делается на последней await-границе ПЕРЕД синхронной секцией, а не «во
время»: `processNextQueued` renew-ит лизу до `clock()+ttl` **непосредственно перед** `await runBacktest(...)`
(momentum sync-loop). Пока синхронный блок < ttl, лиза переживает его даже при полностью заголоданном beat —
это **частый случай**.

**Честная развилка (по ревью #137, п.1 High).** Eager renew — это **митигация, а не полный close**: одиночный
sync-прогон ДЛИННЕЕ `workerLeaseTtlMs` всё ещё может потерять лизу (в один поток во время sync-блока не сработает
ни один таймер). Выбрано (решение заказчика): оставить eager renew как задокументированную митигацию + guidance
по TTL, а структурный полный close вынести в follow-up.

- **Rescope**: P3-5 помечен `MITIGATED, residual tracked` — НЕ закрыт полностью.
- **TTL guidance**: `config.workerLeaseTtlMs` (JSDoc) — держать TTL заметно ВЫШЕ самого длинного ожидаемого
  одиночного sync-прогона на trusted-пути.
- **Follow-up слайс (полный close)**: либо cooperative yield/heartbeat ВНУТРИ вычисления (периодический
  `await` в momentum-loop → beat успевает renew-ить), либо вынос CPU-loop с event-loop (worker_thread).
  Golden-движок (`eff10116…`) при полном фиксе не должен менять математику (byte-identical).
- Гард на `deps.lease` — без лизы renew пропускается (пути без лизы неизменны).
- Sandbox/strategy-путь не трогаем: он yield-ит, beat его renew-ит; таймер тоже покрывает.

## Точка 2 (ревью #137, Medium) — shutdown не терял активный heartbeat

Раньше `pendingRenew = beatTick()` перезаписывался КАЖДЫМ тиком; skipped-тик (guard `beatInFlight`) возвращал
уже-resolved promise, затирая ссылку на реальный in-flight beat → `finally` дожидался не того promise, и
maintenance мог продолжиться ПОСЛЕ завершения loop (shutdown-гонка). Фикс: держим `activeBeat`; `runBeat`
присваивает `activeBeat` ТОЛЬКО когда beat реально стартует (skipped-тик его не трогает), `finally` дожидается
именно живого beat. Тест: медленный (gated) beat + последующие skipped-тики + abort → loop НЕ резолвится, пока
in-flight beat не завершится.

## Точка 3 (ревью #137, Medium) — timer-driven wake покрыт тестом

Добавлен wedged-drain сценарий с припаркованным follower (`waiting_for_compute`, `computeIdentity`) и cache-hit
для его identity: heartbeat (`coalesceMaintain → wakeComputeWaiters`) освобождает follower (`cache_ready →
queued`) при зависшем drain — подтверждает timer-driven wake (а не только timer-driven reap).

## Инварианты

- **Byte-identical goldens**: `renewLease` меняет только `leaseExpiresAt` (тайминг-метаданные), НИКОГДА хешируемый
  выход. Momentum golden `eff10116…` неизменен. Reap/wake на таймере меняют только *когда* обслуживание бежит,
  не *что* оно делает.
- **INV-6**: wake/compute-lock renew по-прежнему гейтед на `coalesceEnabled`; при coalescing OFF beat и тело
  идентичны прежним. `reapAndPublish` зовётся с теми же opts, что и раньше.
- **Single-process путь неизменен**: `buildApp.tick()` (детерминированные тесты) не трогаем — beat только в
  `runWorkerLoop` (multi-process).
- Reap/renew на таймере — best-effort (`.catch`), re-entrancy-guarded, идемпотентны.

## Тесты (TDD)

1. **P3-4 — reap на таймере при зависшем drain.** Store с `claimNextQueued`, который никогда не резолвится
   (drain висит вечно → тело loop не доходит до reap) + преднагруженный orphan (running, истёкшая лиза,
   attempts≥maxAttempts, callbackUrl). `runWorkerLoop` с малым `heartbeatMs`. RED: reap только в теле → orphan
   не реапится (webhook не пришёл). GREEN: reap на таймере → orphan терминализуется `lease_expired` + webhook
   доставлен, несмотря на зависший drain.
2. **P3-4 — wake на таймере при зависшем drain.** Припаркованный follower (`waiting_for_compute`, `ci-1`) +
   cache-hit для `ci-1`; `claimNextQueued` завешен. GREEN: heartbeat (`coalesceMaintain`) освобождает follower
   `cache_ready → queued` при недостижимом теле loop — timer-driven wake (не только reap).
3. **P3-5 (митигация) — eager renew перед синхронным движком.** Momentum-fixture джоба, заклеймлена с лизой;
   `processNextQueued` напрямую (БЕЗ heartbeat); spy на `renewLease`. RED: renew только на beat → за прогон
   renew не случился. GREEN: eager renew перед `runBacktest` → `renewLease(workerId, clock+ttl)` вызван, что
   может быть только eager-renew (beat не тикал). Тест доказывает митигацию (renew на границе), НЕ полный
   close (истечение при sync>ttl — остаточный класс, вынесен в follow-up).
4. **Точка 2 — shutdown ждёт живой beat.** Gated медленный beat + skipped-тики + abort. RED (на баговом
   `pendingRenew`): loop резолвится преждевременно (`expected true to be false`). GREEN (`activeBeat`): loop
   ждёт завершения in-flight beat.
5. **Регрессии**: существующие worker-loop/heartbeat/reap тесты зелёные (тело loop сохранено; renew на beat
   сохранён; INV-6 OFF-путь byte-identical).
