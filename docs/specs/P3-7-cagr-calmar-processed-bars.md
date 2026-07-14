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

Числитель CAGR — `equity[last] / equity[first]`, а КАЖДАЯ `EquityPoint` пишется ПОСЛЕ закрытия своего
бара (`portfolio.equityAt(bar.close)` в `barTs`). Значит время, за которое возникла доходность числителя,
— расстояние между двумя post-close наблюдениями: **`lastTs - firstTs`**. Никакого `+ timeframe` (это
приписало бы доходности ещё один ненаблюдаемый интервал и занизило CAGR; inclusive-bar семантика
`lastTs + timeframe` потребовала бы иного числителя — equity ДО первого бара, initial capital — и
доверенного timeframe, а НЕ выведенного из наблюдаемых gaps, который ненадёжен: завышен при пропусках,
занижен при смещённых multi-symbol сетках). Поэтому timeframe/step вообще не участвует.

```ts
function effectiveElapsedYears(equity: readonly EquityPoint[]): number | null {
  if (equity.length === 0) return null;
  const uniq = new Set(equity.map((p) => p.barTs)); // дубликаты ts (multi-symbol) схлопываются
  if (uniq.size < 2) return null;                   // < 2 временных точек → cagr/calmar не определены → omit
  let firstTs = Infinity, lastTs = -Infinity;
  for (const ts of uniq) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }
  const elapsedMs = lastTs - firstTs;               // span между двумя post-close наблюдениями
  return elapsedMs > 0 ? elapsedMs / MS_PER_YEAR : null;
}
```

Зафиксированные решения:
- **effective elapsed** = `lastTs - firstTs` по реально обработанным уникальным barTs (не по `request.period`).
- **семантика последнего бара** = `lastTs` (equity-point-to-equity-point span; endpoint/time coupling с
  числителем `eq_last/eq_first`). НЕ `lastTs + timeframe`.
- **< 2 уникальных ts** → `null` → omit `cagr`/`calmar` (как `profit_factor`).
- **gaps** учитывают календарное время: `max - min` охватывает пропуск.
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
1. **full coverage** — непрерывные бары → elapsed = `lastTs - firstTs`; cagr/calmar определены.
2. **обрезанное начало** — данные начинаются позже `period.from` → знаменатель по firstTs, НЕ по from.
3. **обрезанное окончание** — данные кончаются раньше `period.to` → по lastTs, НЕ по to.
4. **gaps** — пропущенный бар: elapsed охватывает gap календарно (`max - min`).
5. **multi-symbol duplicate timestamps** — 2 символа на одних ts → период НЕ удваивается (уникальные ts).
6. **< 2 уникальных ts** (1 бар / 1 ts) → cagr/calmar опущены.
7. **точный интеграционный CAGR** — 100→121 за ровно 0.5y → cagr = `1.21^2 - 1 = 0.4641` (endpoint/time
   coupling закреплён).
8. **DEDUP_COMPUTE_VERSION** = `'2'`.
