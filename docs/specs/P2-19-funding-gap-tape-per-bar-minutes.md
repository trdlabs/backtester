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

## Решение — server-derived cadence, один снимок на бар (ревью #131)

Каждый обработанный бар реализует РОВНО один funding-снимок = один cadence-период, начисляемый по ставке
бара. Значит `barMinutes` — это **длительность бара из server-validated timeframe тейпа** (`marketTape.
timeframe`, напр. `'1m'`), константа; НЕ forward/backward span и НЕ значение, выведенное из наблюдаемых
gap'ов (на sparse-тейпе любая наблюдаемая дельта сама может быть gap'ом — тот же класс inference-дефекта,
что закрыт в #128). Gap НЕ экстраполируется по одной ставке: пропущенные снимки просто не начисляются.

```ts
// buildBarEnv:
const cadenceMinutes = exec.fundingEnabled() && marketTape !== undefined
  ? timeframeToMinutes(marketTape.timeframe) : 1;
// processBar funding-блок:
const barMinutes = cadenceMinutes;                    // одна cadence-минута на covered бар
```

- **Ownership** (какие бары держат позицию) обрабатывается выше — settlement'ом `next_bar_open`
  (позиция появляется/исчезает на `open(t+1)`). Поэтому pending entry через gap заполняется на post-gap
  баре (pre-fill gap не держится → не начисляется), а pending exit через gap держит позицию до post-gap
  бара; при этом КАЖДЫЙ covered held-бар начисляет ровно одну cadence-минуту — gap не множится.
- **coverage / stale**: `covered` (present ИЛИ в пределах bounded 1-баровой stale-grace) → 1 cadence;
  `missing` → 0. Present-бар на краю покрытия начисляет только свою cadence-минуту — НЕ live-forward'ит
  ставку через произвольно длинный gap; stale-бар (grace) — тоже 1 cadence; за grace → 0. Freshness
  ограничивает начисление по факту (не «reading.state в начале интервала»).
- **timeframeToMinutes**: парсит `'1m'/'5m'/'1h'/'1d'` → минуты; НЕ выводит из наблюдаемых дельт.

### Провенанс cadence — server DatasetDescriptor, не client request (ревью #131)

`marketTape.timeframe` в обычном engine-path шёл из client `request.timeframe` (worker →
`buildOverlayDataset({ timeframe: r.timeframe })` → `marketTapeFromCanonicalRows` копирует строку). Клиент
мог объявить реальный 1m-тейп как `60m` (каждый снимок → 60 мин funding) или передать `0m`. Фикс:
`buildOverlayDataset` резолвит `DatasetDescriptor` через `port.listDatasets()`, **требует
`request.timeframe === descriptor.timeframe`** (иначе `validation_error`, fail-closed ДО engine-run) и
материализует tape из `descriptor.timeframe` (trusted). Движок парсит cadence общим
`parseTimeframeMs` (main/#128) — `0m`/невалидное → `null` → fail-closed; НЕ второй слабее валидированный
parser.

### Elapsed-aware stale grace (ревью #131)

`FUNDING_STALE_GRACE_BARS` проверялся по предыдущему ОБРАБОТАННОМУ индексу: снимок на 2m считался stale
на следующем обработанном баре 62m (спустя 60 мин). Заряд был ограничен одной cadence-минутой, но
произвольно старая ставка всё равно применялась. Фикс: `fundingReadingAt` принимает опциональный
`cadenceMs`; grace-loop находит coverage-EDGE бар `m` (последнюю covered точку — НЕ sparse change-point
в `point.ts`) и требует `minuteTs - m <= cadenceMs × FUNDING_STALE_GRACE_BARS` по ELAPSED времени.
Runner передаёт trusted cadence; market-access (без `cadenceMs`) сохраняет прежний index-based grace.
Итог: covered@2m, следующий бар 3m (в пределах cadence) → stale (разрешённый 1-баровый grace); covered@2m,
следующий бар 62m → `missing`/0.

## Инвариант contiguous-parity (byte-identical на непрерывном тейпе)

На непрерывном тейпе прежний `gridMinutes = (candles[1].ts - candles[0].ts)/60000` = server cadence,
и он тоже был константой на всех барах → `barMinutes` идентичны → equity/funding/ledger **byte-identical**
(BEATUSDT-фикстура contiguous-start → байт-идентична pre-P2-19). Меняется только output тейпов со
start-gap (где `gridMinutes ≠ cadence`) — корректно.

## Versioned output change

P2-19 меняет engine deterministic output (funding/equity) на **gap-тейпах** (contiguous не затронут),
поэтому **`DEDUP_COMPUTE_VERSION` bump `2`→`3`** (иначе старый result-cache вернул бы pre-fix funding для
gapped-прогонов). `realism-gap.test.ts` тест 1 (NON-CIRCULAR guard) вернулся к оригиналу (одна cadence-минута
на covered бар, независим от `funding.ts`); BEATUSDT байт-идентичен pre-P2-19 (contiguous start), 5b
anchor band держится.

## Тесты (TDD)

Engine-path (`runBacktest` через `runRealismLedger` + synthetic 1m rows; implied barMinutes
восстанавливаются из covered ledger `cost`):
1. **contiguous** — каждый held-бар начисляет ровно 1 мин (cadence).
2. **start-gap** — НЕ множит каждый бар (прежний `gridMinutes = 2` → 2×; фикс → 1).
3. **entry через gap** — pre-fill gap не держится → не начисляется; held-бары по 1 мин.
4. **exit через gap** — exit-бар начисляет 1 cadence (свой снимок), gap не экстраполируется.
5. **sparse [0,60] cadence=1m, entry на final bar** (дискриминирующий) — final-бар начисляет 1 мин,
   НЕ 60 (server cadence, не min-gap).
6. **present-бар перед coverage-gap** (дискриминирующий) — present-бар начисляет 1 мин, НЕ 60 (freshness
   ограничивает); stale-бар (1-баровый grace) — 1 мин; бар за grace — covered=false, 0. Assertions
   требуют КОНКРЕТНЫЕ ledger-записи (без условного `if`).
7. **отсутствие повторных начислений** — ≤ одна ledger-запись на bar ts.

Плюс `realism-gap` NON-CIRCULAR guard (1 cadence/бар, независим от `funding.ts`); полный suite green
(execution-validation на реальном 1m slice byte-identical — contiguous-start не сдвинулся).
