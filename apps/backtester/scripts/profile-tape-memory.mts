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

function buildRows(): CanonicalRowV2[] {
  const rows: CanonicalRowV2[] = [];
  for (let s = 0; s < SYMBOLS; s += 1) {
    const symbol = `SYM${s}USDT`;
    for (let i = 0; i < BARS; i += 1) {
      const px = 100 + Math.sin(i / 50) * 5;
      rows.push({
        symbol,
        minute_ts: T0 + i * 60_000,
        open: px,
        high: px + 0.5,
        low: px - 0.5,
        close: px,
        volume: 1000 + (i % 97),
        turnover: 0,
        oi_total_usd: null,
        has_oi: false,
        liq_long_usd: null,
        liq_short_usd: null,
        has_liq: false,
      } as unknown as CanonicalRowV2);
    }
  }
  return rows;
}

interface Columns {
  symbolIds: Uint16Array;
  ts: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  symbolNames: string[];
}

function toColumns(src: readonly CanonicalRowV2[]): Columns {
  const names: string[] = [];
  const idOf = new Map<string, number>();
  const cols: Columns = {
    symbolIds: new Uint16Array(src.length),
    ts: new Float64Array(src.length),
    open: new Float64Array(src.length),
    high: new Float64Array(src.length),
    low: new Float64Array(src.length),
    close: new Float64Array(src.length),
    volume: new Float64Array(src.length),
    symbolNames: names,
  };
  for (let i = 0; i < src.length; i += 1) {
    const r = src[i] as unknown as Record<string, number & string>;
    let id = idOf.get(r.symbol);
    if (id === undefined) {
      id = names.length;
      names.push(r.symbol);
      idOf.set(r.symbol, id);
    }
    cols.symbolIds[i] = id;
    cols.ts[i] = r.minute_ts;
    cols.open[i] = r.open;
    cols.high[i] = r.high;
    cols.low[i] = r.low;
    cols.close[i] = r.close;
    cols.volume[i] = r.volume;
  }
  return cols;
}

console.log(`\n[tape-memory] символов=${SYMBOLS} баров/символ=${BARS} строк=${N.toLocaleString('ru')} повторов=${REPEATS}\n`);

// --- Память, каждое представление в изоляции ------------------------------------------------------

let held: unknown;

const rowsM = retainedMb(buildRows);
const rows = rowsM.value;
const tapeM = retainedMb(() => marketTapeFromCanonicalRows('tm-fixture', '1m', rows));
held = tapeM.value;
const colsM = retainedMb(() => toColumns(rows));
const cols = colsM.value;
held = undefined;
void held;

// --- Перенос: минимум из повторов -----------------------------------------------------------------

const cloneRowsMs = minMs(REPEATS, () => structuredClone(rows));
const copyColsMs = minMs(REPEATS, () => ({
  symbolIds: cols.symbolIds.slice(),
  ts: cols.ts.slice(),
  open: cols.open.slice(),
  high: cols.high.slice(),
  low: cols.low.slice(),
  close: cols.close.slice(),
  volume: cols.volume.slice(),
}));
const buildColsMs = minMs(REPEATS, () => toColumns(rows));

// Теоретический минимум для колонок — 6 float64 плюс uint16 на строку. Печатается рядом, чтобы
// измеренное число было с чем сверить: если они разошлись, врёт замер, а не арифметика.
const colsTheoryMb = (N * (6 * 8 + 2)) / (1024 * 1024);

console.log('  ПАМЯТЬ (каждое представление в изоляции; куча + буферы ArrayBuffer)');
console.log(`    канонические строки                ${rowsM.mb.toFixed(1).padStart(7)} МБ`);
console.log(`    лента, построенная из них          ${tapeM.mb.toFixed(1).padStart(7)} МБ`);
console.log(`    колонки                            ${colsM.mb.toFixed(1).padStart(7)} МБ   (арифметика: ${colsTheoryMb.toFixed(1)} МБ)`);
console.log('');
console.log('  ПЕРЕНОС ЧЕРЕЗ ГРАНИЦУ ПОТОКА (минимум из повторов)');
console.log(`    строки, structured clone           ${cloneRowsMs.toFixed(0).padStart(7)} мс`);
console.log(`    колонки, копия буферов             ${copyColsMs.toFixed(0).padStart(7)} мс`);
console.log(`    (сборка колонок из строк           ${buildColsMs.toFixed(0).padStart(7)} мс — разово, в кэш)`);
console.log('');
console.log('  ЧЕМ ПЛАТИТЬ ЗА ХРАНЕНИЕ РЯДОМ С ЛЕНТОЙ:');
console.log(`    строками:  +${rowsM.mb.toFixed(1)} МБ к записи кэша (+${((100 * rowsM.mb) / tapeM.mb).toFixed(0)}%), перенос ${cloneRowsMs.toFixed(0)} мс/прогон`);
console.log(`    колонками: +${colsM.mb.toFixed(1)} МБ к записи кэша (+${((100 * colsM.mb) / tapeM.mb).toFixed(0)}%), перенос ${copyColsMs.toFixed(0)} мс/прогон`);
console.log('');
console.log(`  На бар-вычисление перенос стоит: строки ${((cloneRowsMs * 1000) / N).toFixed(1)} мкс, колонки ${((copyColsMs * 1000) / N).toFixed(1)} мкс.`);
console.log('  Сравнивать надо с выигрышем 363 мкс/бар от переноса цикла в поток (bt#197/198).');
console.log('');
