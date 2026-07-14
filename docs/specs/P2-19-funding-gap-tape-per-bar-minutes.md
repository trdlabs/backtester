# P2-19 — funding: per-bar минуты из фактической дельты, не экстраполяция первого интервала

## Проблема

`buildBarEnv` (runner.ts:518) выводит `gridMinutes` из ПЕРВЫХ ДВУХ баров и применяет ко ВСЕМУ прогону:

```ts
const gridMinutes = n > 1 ? (candles[1].ts - candles[0].ts) / 60_000 : 1;
// ... processBar (L492):
computeBarFunding({ ..., barMinutes: gridMinutes, ... })
```

На canonical-тейпах минуты пропадают (реальные данные с gaps). Последствия:
- **Gap между баром 0 и 1** → `gridMinutes = 2` (или больше) → КАЖДЫЙ бар всего прогона заряжается 2× funding
  (equity / pnl / sharpe / ledger неверны).
- **Gap в середине при удерживаемой позиции** → бар заряжается фиксированный `gridMinutes` вместо
  фактического интервала удержания `ts[t] - ts[t-1]` — систематический недочёт.

## Решение — FORWARD-интервал (ревью #131)

Ключ: под `next_bar_open` позиция, установленная settlement'ом бара `t` (на `open(t)` от decision
`t-1`), удерживается от `open(t)` до `open(t+1)`. Значит end-of-bar accrual на баре `t` относится к
интервалу ВПЕРЁД `[ts[t], ts[t+1]]`, а НЕ назад `[ts[t-1], ts[t]]`. Backward-формула переносит funding
между периодами владения на gap-границах:
- **pending entry через gap** переоблагается — backward начислил бы весь gap, хотя позиция открылась
  только на `open` post-gap бара;
- **pending exit через gap** недооблагается — позиция реально удерживалась весь gap до `open` post-gap
  бара, но backward-заряд его теряет.

```ts
// в processBar funding-блоке:
const forwardMinutes = t + 1 < gridTs.length ? (gridTs[t + 1] - gridTs[t]) / 60_000 : timeframeMinutes;
const barMinutes = reading.state === 'stale' ? Math.min(forwardMinutes, timeframeMinutes) : forwardMinutes;
```

- **Средние бары**: `barMinutes = (ts[t+1] - ts[t])/60000` — реальный период удержания post-bar позиции.
- **Последний бар** (`t = n-1`, нет `ts[n]`): позиция force-closed на `close(n-1)` в `finalizeSymbol`,
  т.е. удерживалась ровно один таймфрейм → `barMinutes = timeframeMinutes`.
- **`timeframeMinutes`** = минимальный положительный интервал между обработанными барами (нормальная
  каденция, робастно к gaps: gap — бо́льшая дельта; fallback 1). Выводится из данных, НЕ из `request`.

### Явная gap / stale политика

`covered` определяет заряд: `missing` → 0 (без изменений `computeBarFunding`). Дополнительно **stale**
reading (bounded live-forward один grace-бар за краем покрытия) НЕ должен экстраполировать gap → его
`barMinutes` капится одним `timeframeMinutes`. Это делает stale-grace elapsed-aware по факту: длинный
forward gap на stale-баре не превращается в произвольные N минут по устаревшей ставке. `present` бар
заряжает полный forward (реальный hold по свежей ставке).

## Инвариант contiguous-parity (byte-identical на непрерывном тейпе)

На непрерывном тейпе `forwardMinutes = (ts[t+1]-ts[t])/60000` = const = `timeframeMinutes` = прежний
`gridMinutes` для ВСЕХ баров (включая последний). Множество заряжаемых (held) баров и per-bar минуты
идентичны прежним → equity/funding/ledger **byte-identical**. Меняется только gapped output (корректно).

## Versioned output change

P2-19 меняет engine deterministic output (funding/equity) на **gap-тейпах** (contiguous не затронут),
поэтому **`DEDUP_COMPUTE_VERSION` bump `2`→`3`** (иначе старый result-cache вернул бы pre-fix funding для
gapped-прогонов). `realism-gap.test.ts` тест 1 (NON-CIRCULAR guard) обновлён: его независимый inline-
recompute теперь взвешивает каждый covered бар FORWARD-интервалом `(ts[t+1]-ts[t])` до следующего
обработанного бара — guard остаётся независимым (не импортирует `funding.ts`); held-окно BEATUSDT
полностью funding-covered, так что stale-cap здесь не задействован; 5b anchor band держится (±0.5 bps).

## Тесты (TDD)

Engine-path (`runBacktest` через `runRealismLedger` + synthetic canonical rows; implied barMinutes
восстанавливаются из covered ledger `cost`):
1. **contiguous parity** — непрерывный 1m-тейп: каждый удерживаемый бар заряжает ровно 1 мин
   (forward = timeframe), ledger byte-identical прежнему.
2. **ENTRY pending через gap** — сигнал на баре перед gap; позиция открывается на `open` post-gap бара,
   так что pre-fill gap НЕ начисляется (первый заряжаемый бар = реальный forward-шаг, не gap).
3. **EXIT pending через gap** — позиция удерживается; exit на баре перед gap → pre-gap бар forward
   охватывает gap → начислен реальный hold до `close`.
4. **start-gap** — пропуск ранней минуты: НЕ множит каждый бар (прежний `gridMinutes = 2` → 2×; фикс → 1).
5. **stale reading над gap** — funding-покрытие кончается: stale-бар капится одним timeframe, никаких
   произвольных N минут по устаревшей ставке.
6. **отсутствие повторных начислений** — ≤ одна ledger-запись на bar ts.

Плюс `realism-gap` NON-CIRCULAR guard обновлён на forward-веса (независим от `funding.ts`); полный suite
подтверждает contiguous byte-parity (execution-validation на реальном 1m slice не сдвинулся).
