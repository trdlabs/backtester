// ПАМЯТЬ И ПЕРЕНОС — чем платить за то, чтобы отдать ленту в отдельный поток.
//
// Зачем замер и почему ДО правки. Барному циклу в потоке нужна лента. Строить её там заново нельзя:
// главный поток всё равно строит свою (`dsFingerprint` для дедуп-кэша считается ДО прогона,
// `executedBarTimes` — после), и вторая постройка дублировала бы чтение и обошла `overlayTapeCache`.
// Значит через границу едут данные, и вопрос только в том, В КАКОМ ВИДЕ.
//
// Два кандидата:
//   · канонические строки — плоские объекты, и на той стороне их принимает та же фабрика
//     `marketTapeFromCanonicalRows`, то есть семантика совпадает по построению;
//   · колонки — типизированные массивы, по колонке на поле; переносятся через `transferList` без
//     копирования, но требуют своей сборки ленты на той стороне.
//
// Цена обоих — держать представление в кэше рядом с лентой, потому что после постройки оно сегодня
// выбрасывается. Насколько это дороже, из кода не видно: строка и бар несут разные наборы полей.
//
// МЕТОД. Каждое представление меряется В ИЗОЛЯЦИИ: куча приводится к базовой линии, строится ровно
// одно представление, снимается прирост, представление отпускается, куча возвращается к базовой.
// Первая редакция станка считала приросты подряд, и это дало заведомо ложные числа — «колонки
// занимают 0.0 МБ», потому что между двумя снимками собрался мусор предыдущего шага. Тот же класс
// ошибки, что и в отозванном bt#194: последовательные фазы плюс разностный учёт.
//
// Тайминги — минимум из повторов, а не один замер: копирование аллоцирует, GC ложится случайно.
//
//   pnpm exec tsx apps/backtester/scripts/profile-tape-memory.mts
//   TM_SYMBOLS=5 TM_BARS=40000 TM_REPEATS=7 pnpm exec tsx apps/backtester/scripts/profile-tape-memory.mts

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { encodeTapeColumns, type TapeColumns } from '../src/engine/tape-columns.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const SYMBOLS = Math.max(1, Number(process.env.TM_SYMBOLS ?? 3));
const BARS = Math.max(1, Number(process.env.TM_BARS ?? 20_000));
const REPEATS = Math.max(3, Number(process.env.TM_REPEATS ?? 7));
const T0 = 1_700_000_000_000;
const N = SYMBOLS * BARS;

/**
 * Занятая память = JS-куча ПЛЮС буферы ArrayBuffer.
 *
 * Одного `heapUsed` мало, и это не мелочь: буферы типизированных массивов V8 держит ВНЕ JS-кучи,
 * поэтому колонки в первой редакции станка показывали 0.0 МБ при арифметических 2.9 — не потому,
 * что они бесплатны, а потому что счётчик смотрел не туда. Node отдаёт их отдельной строкой
 * `arrayBuffers`, и складывать надо обе.
 */
function settleHeapMb(): number {
  for (let i = 0; i < 6; i += 1) gc();
  const m = process.memoryUsage();
  return (m.heapUsed + m.arrayBuffers) / (1024 * 1024);
}

/**
 * Прирост кучи, УДЕРЖИВАЕМЫЙ результатом фабрики.
 *
 * Базовая линия снимается непосредственно перед постройкой, а не один раз на весь станок: только
 * так прирост принадлежит именно этому представлению, а не разнице между двумя моментами жизни
 * процесса. Значение возвращается наружу, иначе V8 соберёт его до снимка.
 */
function retainedMb<T>(make: () => T): { mb: number; value: T } {
  const before = settleHeapMb();
  const value = make();
  const after = settleHeapMb();
  return { mb: after - before, value };
}

function minMs(times: number, fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < times; r += 1) {
    const t0 = process.hrtime.bigint();
    const out = fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    void out;
    if (ms < best) best = ms;
    gc();
  }
  return best;
}

/**
 * Строки ленты. `kinds` включает необязательные виды (oi / funding / liq / taker).
 *
 * Мерить надо ОБА края, а не один. Колоночное представление следует композиции: колонка вида
 * существует, только если вид несёт хоть одна строка (то же правило, что у `marketTapeFromCanonicalRows`).
 * Поэтому лента только со свечами стоит семь float64 на строку, а лента со всеми видами —
 * тринадцать, почти вдвое дороже. Реальные датасеты бывают и такими и такими, и одно число вместо
 * двух означало бы либо приятную, либо пугающую половину правды.
 */
function buildRows(kinds: boolean): CanonicalRowV2[] {
  const rows: CanonicalRowV2[] = [];
  for (let s = 0; s < SYMBOLS; s += 1) {
    const symbol = `SYM${s}USDT`;
    for (let i = 0; i < BARS; i += 1) {
      const px = 100 + Math.sin(i / 50) * 5;
      rows.push({
        schema_version: 2,
        symbol,
        minute_ts: T0 + i * 60_000,
        open: px,
        high: px + 0.5,
        low: px - 0.5,
        close: px,
        volume: 1000 + (i % 97),
        turnover: px * (1000 + (i % 97)),
        oi_total_usd: kinds ? 5_000_000 + i : null,
        has_oi: kinds,
        funding_rate: kinds ? -0.0001 : null,
        has_funding: kinds,
        liq_long_usd: kinds ? 1234.5 : null,
        liq_short_usd: kinds ? 678.25 : null,
        has_liquidations: kinds,
        taker_buy_volume_usd: kinds ? 42_000 + i : null,
        taker_sell_volume_usd: kinds ? 41_000 + i : null,
        has_taker_flow: kinds,
      });
    }
  }
  return rows;
}

// Кодировщик — ПРОДОВЫЙ (`src/engine/tape-columns.ts`), а не местная урезанная копия. Первая
// редакция этого станка мерила семь колонок из четырнадцати, и число вышло вдвое оптимистичнее
// правды: реальная лента несёт ещё oi, funding, две стороны liq и две стороны taker. Станок,
// меряющий не то, что поедет в кэш, отвечает на другой вопрос.
console.log(`\n[tape-memory] символов=${SYMBOLS} баров/символ=${BARS} строк=${N.toLocaleString('ru')} повторов=${REPEATS}`);

let failed = false;

function measure(label: string, kinds: boolean): void {
  console.log(`\n══ ${label} ══\n`);

  // Каждое представление меряется В ИЗОЛЯЦИИ; лента удерживается живой на время замера колонок,
  // иначе её сбор лёг бы в чужой прирост.
  let held: unknown;
  const rowsM = retainedMb(() => buildRows(kinds));
  const rows = rowsM.value;
  const tapeM = retainedMb(() => marketTapeFromCanonicalRows('tm-fixture', '1m', rows));
  held = tapeM.value;
  const colsM = retainedMb(() => encodeTapeColumns('tm-fixture', '1m', undefined, rows));
  const cols: TapeColumns = colsM.value;
  held = undefined;
  void held;

  const cloneRowsMs = minMs(REPEATS, () => structuredClone(rows));
  // Копия буферов — то, что делает structured clone на границе потока. Именно КОПИЯ, а не перенос:
  // колонки живут в разделяемом `overlayTapeCache`, и перенос отсоединил бы их у отправителя.
  const copyColsMs = minMs(REPEATS, () => structuredClone(cols));
  const buildColsMs = minMs(REPEATS, () => encodeTapeColumns('tm-fixture', '1m', undefined, rows));

  const f64PerRow =
    7 + // ts, open, high, low, close, volume, turnover — всегда
    (cols.oi !== undefined ? 1 : 0) +
    (cols.funding !== undefined ? 1 : 0) +
    (cols.liq !== undefined ? 2 : 0) +
    (cols.taker !== undefined ? 2 : 0);
  // + Uint16 идентификатора символа и Uint16 флагов на строку.
  const colsTheoryMb = (N * (f64PerRow * 8 + 2 + 2)) / (1024 * 1024);

  console.log('  ПАМЯТЬ (каждое представление в изоляции; куча + буферы ArrayBuffer)');
  console.log(`    канонические строки                       ${rowsM.mb.toFixed(1).padStart(7)} МБ`);
  console.log(`    лента, построенная из них                 ${tapeM.mb.toFixed(1).padStart(7)} МБ`);
  console.log(
    `    колонки (${String(f64PerRow).padStart(2)} float64 + 2×uint16 на строку) ${colsM.mb.toFixed(1).padStart(7)} МБ   (арифметика: ${colsTheoryMb.toFixed(1)} МБ)`,
  );
  console.log('');
  console.log('  ПЕРЕНОС ЧЕРЕЗ ГРАНИЦУ ПОТОКА (минимум из повторов)');
  console.log(`    строки, structured clone                  ${cloneRowsMs.toFixed(0).padStart(7)} мс`);
  console.log(`    колонки, копия буферов                    ${copyColsMs.toFixed(0).padStart(7)} мс`);
  console.log(`    (сборка колонок из строк                  ${buildColsMs.toFixed(0).padStart(7)} мс — разово, в кэш)`);
  console.log('');
  console.log('  ЧЕМ ПЛАТИТЬ ЗА ХРАНЕНИЕ РЯДОМ С ЛЕНТОЙ:');
  console.log(`    строками:  +${rowsM.mb.toFixed(1)} МБ к записи кэша (+${((100 * rowsM.mb) / tapeM.mb).toFixed(0)}%), перенос ${cloneRowsMs.toFixed(0)} мс/прогон`);
  console.log(`    колонками: +${colsM.mb.toFixed(1)} МБ к записи кэша (+${((100 * colsM.mb) / tapeM.mb).toFixed(0)}%), перенос ${copyColsMs.toFixed(0)} мс/прогон`);
  console.log('');
  console.log(`  На бар-вычисление перенос стоит: строки ${((cloneRowsMs * 1000) / N).toFixed(1)} мкс, колонки ${((copyColsMs * 1000) / N).toFixed(1)} мкс.`);

  // САМОПРОВЕРКА, а не украшение отчёта. Замеренный объём колонок обязан сойтись с арифметикой:
  // буферы типизированных массивов — единственная крупная статья, и их размер известен точно.
  // Расхождение означает, что счётчик смотрит не туда (ровно так первая редакция станка выдала
  // «колонки занимают 0.0 МБ», забыв `arrayBuffers`), — и тогда врёт замер, а не арифметика.
  const ratio = colsM.mb / colsTheoryMb;
  if (!(ratio >= 0.9 && ratio <= 1.25)) {
    console.log(
      `\n  ✗ ОТКАЗ: колонки замерены как ${colsM.mb.toFixed(2)} МБ при арифметических ${colsTheoryMb.toFixed(2)} МБ ` +
        `(×${ratio.toFixed(2)}, допуск 0.90–1.25). Число не публикуется — сначала чинить станок.`,
    );
    failed = true;
  }
}

measure('ЛЕНТА ТОЛЬКО СО СВЕЧАМИ (дешёвый край)', false);
measure('ЛЕНТА СО ВСЕМИ ВИДАМИ — oi, funding, liq, taker (дорогой край)', true);

console.log('\n  Сравнивать надо с выигрышем 363 мкс/бар от переноса цикла в поток (bt#197/198).\n');
if (failed) process.exit(4);
