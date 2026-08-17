# P3-6c — job-events retention: POLICY / SPEC (реализация отложена)

> Статус: **только policy/spec**. TTL НЕ проектируется/не реализуется до фиксации обязательного
> audit-retention. Retention-СРОК — **cross-repo решение через control-center**, не выбирается локально.

## 1. Инвентаризация `backtest_job_event`

Схема (`migrations/0001_init.sql`):

```sql
backtest_job_event(
  event_uid PK, job_id, run_id,
  event_type TEXT,            -- lifecycle тип (см. ниже)
  payload_json JSONB,         -- webhook-пейлоад
  delivery_state TEXT,        -- 'pending' | 'delivered' | 'failed'
  delivery_attempts INT,
  created_at_ms BIGINT
)
-- индексы: (run_id, created_at_ms); outbox (created_at_ms) WHERE delivery_state IN ('pending','failed')
```

**Двойное назначение**:
1. **Webhook-outbox** — `deliverOutbox`/`listDeliverable`/`markDelivered` (completion.ts, job-store) шлют
   `pending`/`failed` события и переводят в `delivered`. Индекс `outbox` обслуживает именно это.
2. **Per-run event-log** — `event_type` + `payload_json`, индекс `(run_id, created_at_ms)`.

**Типы событий** (`JobEventType`, job-store.ts) — ТОЛЬКО lifecycle:
`job_accepted` · `job_queued` · `job_started` · `job_completed` · `job_failed` · `job_canceled` ·
`job_expired` · `job_timed_out`.

**Писатели** (`appendEvent`): `submit.ts` (accepted/queued), `worker.ts::processNextQueued`,
`completion.ts::reapAndPublish`. **Читатели**: только outbox-доставка (`listDeliverable`); внешнего
audit/GET-`/events` читателя в `src/` НЕ найдено (`listEvents` не вызывается из прод-кода).

**Promotion/evidence audit — НЕ в этой таблице.** Он в отдельных таблицах:
`backtest_trial_ledger` (0007) и `backtest_promotion_attempt_ledger` (0009). Плюс signed evidence —
content-addressed артефакты. Все они **вне scope P3-6c** и НЕ подлежат TTL здесь.

## 2. Классификация событий (TTL-eligibility)

| Класс | Пример | TTL-eligible? |
|---|---|---|
| Событие НЕ-терминального (active) job | started у running job | **НЕТ** — job активен |
| **Undelivered outbox** (`pending`/`failed`) | webhook ещё не доставлен | **НЕТ** — потеряется доставка |
| Delivered lifecycle-событие терминального ordinary job | delivered `job_completed` завершённого джоба | **кандидат** (только после policy) |
| Promotion/evidence audit | — | **N/A** (в ledger-таблицах, не тут) |

Вывод: `backtest_job_event` — **lifecycle + outbox**, НЕ audit-of-record промоушенов/evidence. Значит
запрет «не удалять promotion/evidence события» выполняется **структурно** (их тут нет). Остаётся вопрос
audit-ценности самого lifecycle-лога.

## 3. Обязательный audit-retention + архивация (открытый вопрос)

- **Есть ли требование хранить lifecycle-лог как audit trail?** В control-center на данный момент
  retention/audit-политики для job events НЕТ (проверено). Значит это **не зафиксировано** и требует
  cross-repo решения.
- **Архивный контур** отсутствует. До его появления TTL-удаление lifecycle-лога = безвозвратная потеря.

## 4. Консервативная рабочая рамка (до policy-решения)

1. **Активные jobs не трогать** — TTL только для событий ТЕРМИНАЛЬНЫХ ordinary jobs.
2. **Undelivered outbox не трогать** — только `delivery_state = 'delivered'`.
3. **Promotion/evidence — вне scope** (в ledger-таблицах; TTL их не касается).
4. **Retention-срок НЕ выбирать локально** — согласовать как cross-repo решение через control-center
   (ecosystem-defaults / repos/trading-backtester.md). До согласования — TTL default OFF и не мержится.
5. При появлении **архивного контура** — экспорт перед удалением (export-then-evict), а не голое DELETE.

## Открытые вопросы для control-center (блокируют реализацию)

- **A.** Обязательный audit-retention для lifecycle job-events: нужен ли, и минимальный срок?
- **B.** Нужен ли архивный контур (cold storage) до включения TTL, или delivered-terminal события можно
  эвиктить без архива?
- **C.** Единый ecosystem retention-default (дни) — где зафиксировать (ecosystem-defaults.yaml?).

## Предполагаемый TTL-дизайн (ПОСЛЕ policy — не реализуется сейчас)

Когда A–C решены: `JobStore.sweepDeliveredEvents(nowMs, ttlMs, batchLimit)` — bounded/indexed/throttled
(зеркало P3-6a/6b: index, `FOR UPDATE SKIP LOCKED`, throttle-cadence независим от TTL, default OFF,
fail-fast env-валидация), удаляющий ТОЛЬКО `delivery_state='delivered'` события терминальных jobs старше
retention. Wired в общий maintenance-seam обоих loop'ов.
