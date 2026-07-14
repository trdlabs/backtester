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

## Решение

Заряжать per-bar минуты из ФАКТИЧЕСКОЙ дельты соседних обработанных баров, никогда не экстраполируя
первый интервал:

```ts
// в processBar, внутри funding-блока (t гарантированно ≥ 1 — см. parity ниже):
const barMinutes = t >= 1 ? (gridTs[t] - gridTs[t - 1]) / 60_000 : 0;
```

`gridMinutes` (поле `BarEnv` + его derivation) удаляется — `gridTs` уже в env.

### Явная gap-политика

Начисление = `perMinuteFraction(rate_as_of(t)) × barMinutes × notional × sign`, где `barMinutes` —
фактические минуты `(ts[t] - ts[t-1])/60000`, а `covered` определяет заряд:
- **covered = false** (reading `missing` — нет снимка ≤ t ИЛИ вне stale-grace) → заряд **0**
  (уже так в `computeBarFunding`: `if (!covered) return 0`).
- **covered = true** (`present`/`stale` в пределах `FUNDING_STALE_GRACE_BARS = 1`) → заряд за фактические
  минуты по ставке as-of бара t.

Cap на gap НЕ нужен: stale-grace = 1 grid-бар, поэтому длинный gap за краем покрытия → `missing` → 0
(funding не выдумывается за неизвестный период); covered остаётся только для коротких gap в пределах
grace, где фактическая дельта мала и корректна. Политика самосогласована с 030 coverage-семантикой.

## Инвариант contiguous-parity (byte-identical на непрерывном тейпе)

Funding-блок исполняется только под `portfolio.position !== null` (runner.ts:481). В модели
`next_bar_open` позиция появляется лишь после `settlePending` на `open(t+1)` от decision бара `≤ t-1`,
поэтому на end-of-bar `t = 0` позиция ВСЕГДА `null` → funding на баре 0 не начисляется, а `barMinutes(0)`
недостижим. Для `t ≥ 1` на непрерывном тейпе `(ts[t] - ts[t-1])/60000` = const = прежний `gridMinutes`.
Значит:
- **contiguous тейп** → per-bar минуты идентичны прежней константе → equity/pnl/ledger **byte-identical**;
- **gap-тейп** → per-bar минуты корректны (gap в начале больше НЕ множит весь прогон; gap в середине
  заряжает фактический интервал, covered-gated).

## Versioned output change

P2-19 меняет engine deterministic output (funding/equity) на **gap-тейпах** (contiguous не затронут),
поэтому **`DEDUP_COMPUTE_VERSION` bump `2`→`3`** (иначе старый result-cache вернул бы pre-fix funding для
gapped-прогонов). `realism-gap.test.ts` тест 1 (NON-CIRCULAR guard) обновлён: его независимый inline-
recompute теперь взвешивает каждый covered бар фактическим интервалом `(ts[t]-ts[t-1])` — guard остаётся
независимым (не импортирует `funding.ts`), просто отражает ту же корректную per-bar-minute семантику;
5b anchor band держится (held-окно BEATUSDT содержит малые gaps в пределах ±0.5 bps).

## Тесты (TDD)

Unit (`computeBarFunding` уже покрыт `funding.test.ts`; здесь — engine-path через `runBacktest`/ledger):
1. **contiguous parity** — непрерывный 1m-тейп с funding: `fundingLedger` + equity byte-identical до и
   после (та же величина, что при прежнем `gridMinutes`); заряд каждого удерживаемого бара = 1 мин.
2. **gap в начале** — пропуск 2-й минуты: прежний код дал бы `gridMinutes = 2` и 2× заряд на КАЖДОМ
   баре; фикс → каждый нормальный бар заряжается 1 мин (не 2×).
3. **gap в середине при удержании** — пропущенная минута между t-1 и t: бар t заряжает фактические
   `(ts[t]-ts[t-1])` минут (covered) ИЛИ 0 (missing за grace), не фиксированный `gridMinutes`.
4. **multi-symbol** — разные per-symbol сетки/gaps: каждый символ считает свои per-bar минуты из
   собственных `gridTs` (нет протечки константы между символами).
5. **отсутствие повторных начислений** — ровно одна `fundingLedger`-запись на удерживаемый бар; gap не
   создаёт дублей и не двоит minute-заряды.
