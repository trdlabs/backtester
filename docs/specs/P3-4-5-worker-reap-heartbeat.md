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

## P3-5 — Heartbeat на event-loop

**Проблема.** Beat — `setInterval` на event-loop. Trusted momentum-путь (`runBacktest`): один `await
computeSignals`, затем **синхронный** `for` по символам с `simulateSymbol` (tight per-bar loop, БЕЗ `await`). На
большой вселенной/длинной 1m-ленте эта синхронная секция дольше `workerLeaseTtlMs` блокирует event-loop → beat
не может сработать → renew лизы голодает → спурьёзное истечение лизы → другой воркер реапит «истёкшую» джобу и
**повторно гоняет движок** (терминальный CAS от double-commit спасает корректность, но работа + charge сожжены).
Sandbox/strategy-путь идёт через async IPC (yield-ит), поэтому beat там срабатывает нормально — дефект
специфичен для trusted in-process momentum-пути.

**Фикс (ревьюер: «heartbeat вне синхронного пути»).** В одном Node-потоке никакой таймер не сработает во время
синхронного блока — поэтому renew делается на последней await-границе ПЕРЕД синхронной секцией, а не «во время»:
`processNextQueued` renew-ит лизу до `clock()+ttl` **непосредственно перед** `await runBacktest(...)` (momentum
sync-loop). Пока синхронный блок < ttl, лиза переживает его даже при полностью заголоданном beat. Для блоков
> ttl в один поток без yield-а сделать нечего — корректность держит терминальный CAS (ревьюер это признаёт).

- Гард на `deps.lease` — без лизы renew пропускается (пути без лизы неизменны).
- Sandbox/strategy-путь не трогаем: он yield-ит, beat его renew-ит; таймер тоже покрывает.

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
2. **P3-5 — eager renew перед синхронным движком.** Momentum-fixture джоба, заклеймлена с лизой; `heartbeatMs`
   огромный (beat НЕ срабатывает за короткий in-process прогон); spy на `renewLease`. RED: renew только на
   beat → за прогон renew не случился. GREEN: eager renew перед `runBacktest` → `renewLease(workerId,
   clock+ttl)` вызван during processing, что может быть только eager-renew (beat не тикал).
3. **Регрессии**: существующие worker-loop/heartbeat/reap тесты зелёные (тело loop сохранено; renew на beat
   сохранён; INV-6 OFF-путь byte-identical).
