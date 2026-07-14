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

Новый `sweepExpired(nowMs, olderThanMs)` → `DELETE WHERE lock_expires_at_ms < nowMs - olderThanMs`.
Grace `olderThanMs` (= `computeLockTtlMs`) гарантирует, что `wakeComputeWaiters` успел прочитать
истёкший failure-лок (reason) и переизбрать лидера ДО удаления строки (переизбранный лидер re-acquire'ит
UPSERT'ом — строка переиспользуется, не sweep'ится). Sweep вызывается в worker-loop рядом с
`wakeComputeWaiters`, только при coalescing-on + computeLock present.

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
Integration (worker, in-memory coalescing):
3. **success eager release** — успешный лидер удаляет свой лок (get = undefined); waiting-follower всё
   равно будится `cache_ready`.
4. **failure keeps expire** — провалившийся лидер оставляет истёкшую строку; follower переизбирается с
   `leader_failed` (не `lock_expired`).
5. **loop sweep** — orphan истёкший лок за пределами grace удаляется проходом loop; свежий — нет.
6. **INV-6** — coalescing OFF: ни release, ни sweep не вызываются (лок-стор не трогается).
