# P3-6a — compute-lock: eager release + cleanup истёкших локов

## Проблема (часть P3-6)

`backtest_compute_lock` (coalescing, keyed by `computeIdentity`) растёт безлимитно:
- **success-путь НЕ освобождает лок** (worker.ts: после `resultCache.put` лидер держит лок до TTL) — по
  одной мёртвой строке на КАЖДЫЙ успешный compute.
- `expire()` (failure-путь, worker.ts:1074) лишь выставляет `lock_expires_at_ms = now` — **строку не
  удаляет**; InMemory-`Map` тоже не удаляет. Distinct `computeIdentity` копятся навсегда.
- Orphan-локи (лидер крашнулся без waiting-followers, re-election не случился) остаются истёкшими навсегда.

(P3-6b — TTL result-cache; P3-6c — job-events retention — отдельными слайсами.)

## Решение

### 1. Eager release на success (DELETE)

`wakeComputeWaiters` будит followers по **cache-индексу** (`resultCache.lookup(ci)` → `cache_ready`,
release ALL), НЕ читая лок. Значит после `resultCache.put` лок followers больше не нужен → лидер
**удаляет** строку (не ждёт TTL):

```ts
// worker.ts, лидер-success, сразу после dedup populate:
if (leaderIdentity !== undefined && deps.computeLock !== undefined) {
  await deps.computeLock.release(leaderIdentity, deps.lease!.workerId).catch(() => {});
}
```

Coalescing включается только при dedup-on (kill-switch), поэтому при `leaderIdentity` set cache всегда
популируется; если `put` упал (best-effort) — followers re-elect'ят и пересчитают (корректно, без leak).

### 2. Failure-путь остаётся `expire` (не delete)

`wakeComputeWaiters` при истёкшем локе читает `computeLock.get(ci)` + `store.get(leaderRunId)` чтобы
отличить `leader_failed` (job терминально-провален) от `lock_expired`. DELETE на failure стёр бы строку →
reason схлопнулся бы в `lock_expired`. Поэтому failure оставляем `expire()` (строка живёт истёкшей),
а чистит её **sweep** ниже.

### 3. Sweep истёкших локов (cleanup orphans)

Новый `sweepExpired(nowMs, olderThanMs, batchLimit)` → bounded `DELETE` (oldest-first, LIMIT batchLimit)
над индексом `lock_expires_at_ms`; throttled (не каждый poll).
Grace `olderThanMs` (= `computeLockTtlMs`) гарантирует, что `wakeComputeWaiters` успел прочитать
истёкший failure-лок (reason) и переизбрать лидера ДО удаления строки (переизбранный лидер re-acquire'ит
UPSERT'ом — строка переиспользуется, не sweep'ится). Sweep вызывается в worker-loop рядом с
`wakeComputeWaiters`, только при coalescing-on + computeLock present.

## Ревью #133 — уточнения

### Общая maintenance-функция для ОБОИХ loop'ов (High #1)

Sweep жил только в `runWorkerLoop` (multi-process); `buildApp.tick()` (single-process autoWorker) звал
`wakeComputeWaiters` БЕЗ sweep → в этом режиме orphan-локи копились. Вынесено в
`coalesce/maintenance.ts::createCoalesceMaintenance(deps, opts)` — один шаг (wake + throttled sweep) с
собственным throttle-состоянием; создаётся один раз на lifetime loop'а и зовётся каждым проходом в
ОБОИХ контурах (`runWorkerLoop` и `tick()`). Интеграционный тест — через `buildApp` + новый
`AppHandles.tick()`.

### Fenced release по generation (High #2)

`release` фенсится не только `(computeIdentity, workerId)`, но и `leaderRunId`:
`DELETE … WHERE compute_identity=$1 AND lock_owner_worker_id=$2 AND leader_run_id=$3`. Иначе старый run
(тот же WORKER_ID) удалил бы лок, переизбранный НОВЫМ run'ом под тем же worker'ом. Worker передаёт свой
`runId`. Тест: run-A/w1 → expiry → acquire run-B/w1 → stale release(A) НЕ удаляет B.

### Bounded + indexed + throttled sweep (Medium #3)

- **Index**: миграция `0010_compute_lock_expiry_index.sql` — `CREATE INDEX … ON backtest_compute_lock
  (lock_expires_at_ms)`, чтобы sweep-DELETE не был full-table scan.
- **Bounded batch**: `sweepExpired(nowMs, olderThanMs, batchLimit)` — Pg: `DELETE … WHERE ctid IN
  (SELECT ctid … WHERE lock_expires_at_ms < … ORDER BY lock_expires_at_ms LIMIT $2)`; InMemory: oldest-first
  slice(batchLimit). Default batch 1000.
- **Throttle**: sweep не каждый poll, а не чаще `sweepIntervalMs` (default = `computeLockTtlMs`); wake
  остаётся каждый проход.

## Инварианты

- **INV-6 (coalescing OFF byte-identical)**: `release`/`sweepExpired` вызываются ТОЛЬКО под
  `coalesceEnabled && computeLock` — при OFF локов нет, поведение loop не меняется.
- Release/sweep — best-effort (`.catch(() => {})`), не валят прогон (как `expire`/`renew`).
- `release`/`sweepExpired` идемпотентны; release удаляет только строку владельца (`AND
  lock_owner_worker_id = $2`).

## Тесты (TDD)

Unit (`compute-lock` store, InMemory + Pg-gated):
1. **release удаляет строку** — после `acquire` + `release(owner)` → `get` = undefined; не-владелец не удаляет.
2. **sweepExpired** — удаляет только строки с `lock_expires_at_ms < now - grace`; живые/недавно-истёкшие
   (в пределах grace) остаются.
Integration (`buildApp.tick()` single-process + store-level):
3. **success eager release** — успешный лидер удаляет свой лок (get = undefined); waiting-follower всё
   равно будится `cache_ready`.
4. **failure keeps expire** — провалившийся лидер оставляет истёкшую строку; follower переизбирается с
   `leader_failed` (не `lock_expired`).
5. **loop sweep** — orphan истёкший лок за пределами grace удаляется проходом loop; свежий — нет.
6. **INV-6** — coalescing OFF: ни release, ни sweep не вызываются (лок-стор не трогается).
