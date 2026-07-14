# P3-7 — cagr/calmar по реально обработанным барам, не по запрошенному периоду

## Проблема

`assembleResult` (runner.ts:823) считает elapsed-время для cagr/calmar из **запрошенного** окна:

```ts
const elapsedYears = elapsedYearsOf(request.period); // (to - from) / MS_PER_YEAR
```

При частичном покрытии (данные не заполняют весь `period`, но прогон НЕ reject — напр. warmup-скипы,
короткая лента, gaps) знаменатель CAGR завышен → cagr/calmar **занижены**. Эти метрики питают
qualification-поверхности, поэтому это correctness-баг, а не косметика.

## Решение — versioned correctness fix (без флага)

Считать elapsed из **реально обработанных уникальных barTs**. Источник — `acc.equityCurve`: каждая
`EquityPoint` несёт `barTs` и пишется РОВНО на обработанных барах (warmup-скип не пишет equity), а
`cagr`/`calmar` уже возвращают `null` (⇒ omit) при `elapsedYears === null`.

**Флаг НЕ вводим** — он сделал бы результат зависимым от env. Это versioned correctness fix:
результаты partial-coverage прогонов меняются ОЖИДАЕМО, поэтому **bump `DEDUP_COMPUTE_VERSION` `1`→`2`**
(иначе старый result-cache вернул бы прежние, неверные метрики).

### Семантика (зафиксировано)

```ts
function effectiveElapsedYears(equity: readonly EquityPoint[]): number | null {
  if (equity.length === 0) return null;
  // Уникальные обработанные barTs: дубликаты ts по символам (multi-symbol) схлопываются → НЕ расширяют
  // период; gaps остаются в календарном времени (min..max охватывает пропуск).
  const uniq = Array.from(new Set(equity.map((p) => p.barTs))).sort((a, b) => a - b);
  if (uniq.length < 2) return null; // < 2 временных точек → cagr/calmar не определены → omit
  let step = Number.POSITIVE_INFINITY; // timeframe = минимальный шаг между соседними уникальными ts
  for (let i = 1; i < uniq.length; i += 1) step = Math.min(step, uniq[i] - uniq[i - 1]);
  const firstTs = uniq[0];
  const lastTs = uniq[uniq.length - 1];
  // Каждый бар покрывает свой интервал [ts, ts+step); последний бар добавляет ещё один шаг →
  // effective calendar time = (lastTs + step) - firstTs.
  const elapsedMs = lastTs + step - firstTs;
  return elapsedMs > 0 ? elapsedMs / MS_PER_YEAR : null;
}
```

Зафиксированные решения:
- **effective elapsed** = по реально обработанным уникальным barTs (не по `request.period`).
- **семантика последнего бара** = `lastTs + timeframe` (бар = интервал `[ts, ts+T)`; N баров = N·T
  времени — корректнее для CAGR, чем `lastTs`). `timeframe` выводится как минимальный шаг между
  соседними уникальными ts (самодостаточно, не зависит от request-поля, которое может врать про данные).
- **< 2 уникальных ts** → `null` → omit `cagr`/`calmar` (как `profit_factor`).
- **gaps** учитывают календарное время: `min..max` охватывает пропуск, `step` = нормальный бар-интервал
  (минимальный diff), пропущенные бары НЕ добавляют лишний step.
- **multi-symbol duplicate timestamps** НЕ расширяют период (`Set` схлопывает; N символов на одном ts = 1).
- **partial-coverage результаты меняются** — ожидаемо (versioned fix).

## Изменения

- `runner.ts`: заменить `elapsedYearsOf(request.period)` в `assembleResult` на
  `effectiveElapsedYears(acc.equityCurve)`; удалить `elapsedYearsOf` (единственный вызов) — либо
  переиспользовать имя. `computeMetrics` / `MetricsContext` НЕ меняются (elapsedYears уже параметр).
- `dedup/version.ts`: `DEDUP_COMPUTE_VERSION = '2'` + комментарий-обоснование.

## Blast radius

- **Goldens byte-identical**: ни одна fixture (напр. `baseline.json` = `['pnl','max_drawdown','win_rate',
  'sharpe']`) не запрашивает cagr/calmar через полный прогон → equivalence golden `0be9931c` не затронут.
- **`metrics.test.ts`** (unit `computeMetrics` с явным `elapsedYears`) — API не менялся, не затронут.
- **dedup/coalesce тесты** проверяют РАВЕНСТВО identity между запросами (не конкретную строку) → синхронный
  bump всех identity безопасен.

## Тесты (TDD)

Unit для `effectiveElapsedYears` (либо через `assembleResult`/`runBacktest` результат):
1. **full coverage** — непрерывные бары → elapsed = `(lastTs+step) - firstTs`; cagr/calmar определены.
2. **обрезанное начало** — данные начинаются позже `period.from` → знаменатель по firstTs, НЕ по from
   (cagr выше, чем при старой формуле).
3. **обрезанное окончание** — данные кончаются раньше `period.to` → по lastTs+step, НЕ по to.
4. **gaps** — пропущенный бар: elapsed охватывает gap календарно, step = нормальный интервал.
5. **multi-symbol duplicate timestamps** — 2 символа на одних ts → период НЕ удваивается (уникальные ts).
6. **< 2 уникальных ts** (1 бар / 1 ts) → cagr/calmar опущены.
7. **DEDUP_COMPUTE_VERSION** = `'2'`.
