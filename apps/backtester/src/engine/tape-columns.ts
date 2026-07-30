// Колоночное представление канонических строк — то, в чём лента переезжает через границу потока.
//
// ЗАЧЕМ. Барный цикл считается в отдельном потоке (`engine/thread/`), а `MarketTapeDataset` через
// `postMessage` не проходит: это объект с методами, а structured clone копирует данные и теряет
// замыкания. Построить ленту в потоке заново тоже нельзя — главный поток всё равно строит свою
// (`dsFingerprint` в `jobs/worker.ts` считается ДО прогона и кормит дедуп-гейт), и вторая постройка
// дублировала бы чтение источника в обход `overlayTapeCache`. Значит через границу едут ДАННЫЕ.
//
// ПОЧЕМУ КОЛОНКИ, А НЕ СТРОКИ. Замер bt#199 на 60 тыс. строк: канонические строки — 12.5 МБ и
// 164–211 мс на structured clone; колонки — 2.9 МБ и 1 мс (тогда мерился сокращённый набор из семи
// полей; полный набор ниже дороже, и станок `scripts/profile-tape-memory.mts` меряет уже его). Разница
// не в объёме как таковом, а в форме: массив объектов клонируется по объекту, типизированный массив —
// одним memcpy буфера.
//
// ПОЧЕМУ БЕЗ transferList. Соблазн перенести буферы вместо копирования есть, и он ошибочен: колонки
// живут в РАЗДЕЛЯЕМОМ `overlayTapeCache`, а перенос ОТСОЕДИНЯЕТ буфер на стороне отправителя. Первый
// прогон унёс бы данные из кэша, и следующий получил бы запись с нулевыми массивами — молча, без
// ошибки. Копия в 1–3 мс на прогон против выигрыша в 363 мкс/бар не стоит этого риска, поэтому
// помощника для transferList здесь нет намеренно.
//
// ТОЧНОСТЬ. Кодировка обязана быть round-trip точной, а не «достаточной для текущей стратегии».
// Прогон трогает не все поля (`short_after_pump` не читает taker), поэтому потеря целой колонки
// прошла бы любой гейт на совпадение хэша прогона. Проверяется отдельно — `test/tape-columns.test.ts`.
//
// Три факта, которые кодируются РАЗДЕЛЬНО, потому что раздельно и наблюдаются:
//   · `has_*` флаг вида и nullness его значения. Контракт говорит «null ⟺ has=false», но выводить
//     одно из другого нельзя: тогда битые данные молча чинились бы на границе потока, и место, где
//     они испортились, стало бы ненаходимым.
//   · present-zero. `taker={0,0}` при `has_taker_flow=true` — валидное наблюдение, а не отсутствие.
//   · присутствие вида ЦЕЛИКОМ. `marketTapeFromCanonicalRows` кладёт колонку в источник ленты,
//     только если её несёт хоть одна строка, и `kindCoverage` разводит отсутствующий вид (present:false,
//     разрыв во всю сетку) и пустой (present:true, нулевое покрытие). Блоки ниже следуют тому же
//     правилу — присутствуют ровно тогда, когда есть что нести.

import type { CanonicalRowV2, MarketTapeDataset } from '@trading/research-contracts/research';
import { marketTapeFromCanonicalRows } from './market-tape.js';

/** Биты `flags`: отдельно факт наблюдения вида, отдельно наличие каждого значения. */
const F_HAS_OI = 1 << 0;
const F_HAS_FUNDING = 1 << 1;
const F_HAS_LIQ = 1 << 2;
const F_HAS_TAKER = 1 << 3;
const F_OI = 1 << 4;
const F_FUNDING = 1 << 5;
const F_LIQ_LONG = 1 << 6;
const F_LIQ_SHORT = 1 << 7;
const F_TAKER_BUY = 1 << 8;
const F_TAKER_SELL = 1 << 9;

/** Потолок идентификатора символа — ширина `Uint16Array`. */
const MAX_SYMBOLS = 65_536;

/** Пара колонок вида, у которого две величины на строку. */
export interface ColumnPair {
  readonly a: Float64Array;
  readonly b: Float64Array;
}

/**
 * Колонки одной материализации: по массиву на поле плюс словарь символов.
 *
 * `datasetRef` и `timeframe` едут ВНУТРИ, а не рядом, и это не удобство. `timeframe` здесь — тот,
 * которым лента уже построена, то есть таймфрейм ДЕСКРИПТОРА датасета, а не тот, что назвал клиент
 * (P2-19: относительно переклейки 1m как 60m). Носи их спека прогона отдельным полем — поток мог бы
 * получить пару «колонки от одной ленты, метки от другой», и защита, стоящая в `buildOverlayDataset`,
 * обошлась бы сама собой. Внутри объекта они неразделимы по построению.
 */
export interface TapeColumns {
  readonly datasetRef: string;
  /** Таймфрейм ДЕСКРИПТОРА датасета — тот же, которым построена лента. */
  readonly timeframe: string;
  readonly rowCount: number;
  /** Словарь символов; `symbolIds[i]` — индекс в нём. */
  readonly symbolNames: readonly string[];
  readonly symbolIds: Uint16Array;
  readonly minuteTs: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  readonly turnover: Float64Array;
  /** Флаги вида и наличия значений, по строке. */
  readonly flags: Uint16Array;
  /** Блоки необязательных видов — присутствуют ⟺ вид несёт хоть одна строка. */
  readonly oi?: Float64Array;
  readonly funding?: Float64Array;
  readonly liq?: ColumnPair;
  readonly taker?: ColumnPair;
}

/** Материализация оверлей-датасета: лента и (опционально) её колоночный двойник для потока. */
export interface OverlayMaterialization {
  readonly tape: MarketTapeDataset;
  /**
   * Колонки той же ленты. Отсутствуют, когда путь потока в процессе не включён: строить и держать их
   * в кэше без потребителя — чистая надбавка к памяти воркера.
   */
  readonly columns?: TapeColumns;
}

/** Закодировать канонические строки в колонки. Порядок строк сохраняется как есть. */
export function encodeTapeColumns(
  datasetRef: string,
  timeframe: string,
  rows: readonly CanonicalRowV2[],
): TapeColumns {
  const n = rows.length;
  const symbolNames: string[] = [];
  const idOf = new Map<string, number>();

  const symbolIds = new Uint16Array(n);
  const minuteTs = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);
  const turnover = new Float64Array(n);
  const flags = new Uint16Array(n);

  // Необязательные блоки аллоцируются лениво: пока вид не встретился, платить за него незачем —
  // на ленте только со свечами это 48 из 108 байт на строку.
  let oi: Float64Array | undefined;
  let funding: Float64Array | undefined;
  let liqLong: Float64Array | undefined;
  let liqShort: Float64Array | undefined;
  let takerBuy: Float64Array | undefined;
  let takerSell: Float64Array | undefined;

  for (let i = 0; i < n; i += 1) {
    const r = rows[i];

    let id = idOf.get(r.symbol);
    if (id === undefined) {
      if (symbolNames.length >= MAX_SYMBOLS) {
        // Молчаливое переполнение Uint16 перепутало бы символы местами — а это не «слегка неточная
        // лента», это чужие свечи под чужим именем. Невозможное состояние обязано падать.
        throw new Error(
          `encodeTapeColumns: символов больше ${MAX_SYMBOLS} — идентификатор символа не вмещает "${r.symbol}"`,
        );
      }
      id = symbolNames.length;
      symbolNames.push(r.symbol);
      idOf.set(r.symbol, id);
    }
    symbolIds[i] = id;

    minuteTs[i] = r.minute_ts;
    open[i] = r.open;
    high[i] = r.high;
    low[i] = r.low;
    close[i] = r.close;
    volume[i] = r.volume;
    turnover[i] = r.turnover;

    let f = 0;
    if (r.has_oi) f |= F_HAS_OI;
    if (r.has_funding) f |= F_HAS_FUNDING;
    if (r.has_liquidations) f |= F_HAS_LIQ;
    if (r.has_taker_flow) f |= F_HAS_TAKER;

    if (r.oi_total_usd !== null) {
      oi ??= new Float64Array(n);
      oi[i] = r.oi_total_usd;
      f |= F_OI;
    }
    if (r.funding_rate !== null) {
      funding ??= new Float64Array(n);
      funding[i] = r.funding_rate;
      f |= F_FUNDING;
    }
    if (r.liq_long_usd !== null) {
      liqLong ??= new Float64Array(n);
      liqLong[i] = r.liq_long_usd;
      f |= F_LIQ_LONG;
    }
    if (r.liq_short_usd !== null) {
      liqShort ??= new Float64Array(n);
      liqShort[i] = r.liq_short_usd;
      f |= F_LIQ_SHORT;
    }
    if (r.taker_buy_volume_usd !== null) {
      takerBuy ??= new Float64Array(n);
      takerBuy[i] = r.taker_buy_volume_usd;
      f |= F_TAKER_BUY;
    }
    if (r.taker_sell_volume_usd !== null) {
      takerSell ??= new Float64Array(n);
      takerSell[i] = r.taker_sell_volume_usd;
      f |= F_TAKER_SELL;
    }

    flags[i] = f;
  }

  // Стороны liq/taker аллоцируются независимо (одна может быть null при непустой другой), а блок
  // цел, если появилась хотя бы одна: недостающая половина — нули, отключённые своим битом.
  const liq: ColumnPair | undefined =
    liqLong !== undefined || liqShort !== undefined
      ? { a: liqLong ?? new Float64Array(n), b: liqShort ?? new Float64Array(n) }
      : undefined;
  const taker: ColumnPair | undefined =
    takerBuy !== undefined || takerSell !== undefined
      ? { a: takerBuy ?? new Float64Array(n), b: takerSell ?? new Float64Array(n) }
      : undefined;

  return {
    datasetRef,
    timeframe,
    rowCount: n,
    symbolNames,
    symbolIds,
    minuteTs,
    open,
    high,
    low,
    close,
    volume,
    turnover,
    flags,
    ...(oi !== undefined ? { oi } : {}),
    ...(funding !== undefined ? { funding } : {}),
    ...(liq !== undefined ? { liq } : {}),
    ...(taker !== undefined ? { taker } : {}),
  };
}

/** Восстановить канонические строки из колонок. Обратна `encodeTapeColumns` поле в поле. */
export function decodeTapeColumns(cols: TapeColumns): CanonicalRowV2[] {
  const n = cols.rowCount;
  const rows: CanonicalRowV2[] = new Array<CanonicalRowV2>(n);
  const { flags, oi, funding, liq, taker, symbolNames } = cols;

  for (let i = 0; i < n; i += 1) {
    const f = flags[i];
    const symbol = symbolNames[cols.symbolIds[i]];
    if (symbol === undefined) {
      throw new Error(`decodeTapeColumns: строка ${i} ссылается на символ ${cols.symbolIds[i]}, которого нет в словаре`);
    }
    rows[i] = {
      schema_version: 2,
      minute_ts: cols.minuteTs[i],
      symbol,
      open: cols.open[i],
      high: cols.high[i],
      low: cols.low[i],
      close: cols.close[i],
      volume: cols.volume[i],
      turnover: cols.turnover[i],
      oi_total_usd: (f & F_OI) !== 0 && oi !== undefined ? oi[i] : null,
      funding_rate: (f & F_FUNDING) !== 0 && funding !== undefined ? funding[i] : null,
      liq_long_usd: (f & F_LIQ_LONG) !== 0 && liq !== undefined ? liq.a[i] : null,
      liq_short_usd: (f & F_LIQ_SHORT) !== 0 && liq !== undefined ? liq.b[i] : null,
      has_oi: (f & F_HAS_OI) !== 0,
      has_funding: (f & F_HAS_FUNDING) !== 0,
      has_liquidations: (f & F_HAS_LIQ) !== 0,
      taker_buy_volume_usd: (f & F_TAKER_BUY) !== 0 && taker !== undefined ? taker.a[i] : null,
      taker_sell_volume_usd: (f & F_TAKER_SELL) !== 0 && taker !== undefined ? taker.b[i] : null,
      has_taker_flow: (f & F_HAS_TAKER) !== 0,
    };
  }
  return rows;
}

/**
 * Собрать ленту из колонок — ровно той же фабрикой, что и главный поток.
 *
 * Проходить через `marketTapeFromCanonicalRows`, а не собирать `MarketTapeDataset` напрямую, —
 * решение, а не лень. Composition-following, дедуп funding в change-points, порядок символов,
 * coverage-модель: всё это живёт в фабрике, и вторая её реализация на стороне потока разъезжалась бы
 * с первой ровно тогда, когда фабрику поменяют. Здесь путь один, и он общий.
 */
export function tapeFromColumns(cols: TapeColumns): MarketTapeDataset {
  const result = marketTapeFromCanonicalRows(cols.datasetRef, cols.timeframe, decodeTapeColumns(cols));
  if (!result.ok) {
    throw new Error(`tapeFromColumns: постройка ленты не удалась (${result.reason}): ${result.detail}`);
  }
  return result.tape;
}
