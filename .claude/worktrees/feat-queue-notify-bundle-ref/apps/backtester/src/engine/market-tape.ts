// 023 — loader сырой рыночной ленты (US2, FR-001/002/003/004/005, research R7/R8/R11).
//
// `buildMarketTape(source)` строит материализованный per-symbol minute-indexed `MarketTapeDataset`
// ТОЛЬКО из raw-market источника (tape-фикстура §10 или adapter из 010 `CanonicalRow`). Guard
// отклоняет expected-output источники (trades/fills/orders/…) стабильной причиной `non_market_source`.
// Сериализуемая событийная форма даётся `dataset.toTape()` (канонический порядок §7). Research-only:
// никаких live/broker/exchange/Postgres/host-fs импортов (только pure-маппинг типов).
//
// 023 / US3 (детерминизм, FR-005/015/016, R7): этот модуль производит ТОЛЬКО детерминированные
// canonical-serializable структуры — никаких `Date.now()`/`Math.random()`/host-путей/temp/env в
// форме ленты или coverage. Порядок символов (`sort()`), событий (`compareMarketTapeEvents`) и
// coverage-entries (symbol→kind) фиксирован; сериализация выполняется ВЫШЕ по стеку через
// `canonicalJson` (8-dp quantize) поверх `toTape()`/`coverage()`. Машинно подтверждается
// `verify_023_determinism.mjs`.

import type { Bar } from '@trading/research-contracts/research';
import type { CanonicalRow, CanonicalRowV2 } from '@trading/research-contracts/research';
import { SUPPORTED_MARKET_DATA_KINDS } from '@trading/research-contracts/research';
import {
  type CoverageModel,
  type FundingPoint,
  type FundingReading,
  type FundingSnapshot,
  type KindCoverage,
  type LiquidationSnapshot,
  type MarketDataCoverageState,
  type MarketDataGap,
  type MarketDataKind,
  type MarketTape,
  type MarketTapeDataset,
  type MarketTapeEvent,
  type MinuteColumn,
  type OpenInterestSnapshot,
  type RawMarketTapeSource,
  type TakerSnapshot,
  type TapeBuildResult,
  compareMarketTapeEvents,
} from '@trading/research-contracts/research';

/**
 * 030 — funding stale-grace (R6): сколько grid-минут за краем `has_funding`-покрытия рейт ещё считается
 * `stale` (bounded live-forward), прежде чем стать `missing`. Одна coverage-cadence-минута (грид-шаг) —
 * малая детерминированная доля интервала. Источник истины для reading-staleness (market-access) И
 * coverage-state (kindCoverage) — чтобы они не разъезжались. НЕ keyed на спейсинге change-point'ов.
 */
export const FUNDING_STALE_GRACE_BARS = 1;

/**
 * 030 — единственный источник истины для funding-чтения на произвольную минуту грида.
 * `present` ⟺ минута funding-покрыта; `stale` ⟺ за краем покрытия в пределах grace (отдаётся
 * последний реальный снимок — bounded live-forward, НЕ carry-forward); `missing` ⟺ нет снимка
 * `ts ≤ minuteTs` ИЛИ вне grace. Используется market-access (fundingAsOf/fundingWindow) И runner
 * (end-of-bar accrual), чтобы stale-семантика не разъезжалась.
 */
export function fundingReadingAt(
  fundingCol: MinuteColumn<FundingSnapshot> | undefined,
  gridTs: readonly number[],
  minuteTs: number,
  minuteIdx: number,
): FundingReading {
  const snap = fundingCol === undefined ? undefined : fundingCol.at(minuteTs);
  if (snap === undefined || fundingCol === undefined) return Object.freeze({ state: 'missing' });
  const point: FundingPoint = Object.freeze({ ts: snap.ts, fundingRate: snap.fundingRate });
  if (fundingCol.covered(minuteTs)) return Object.freeze({ state: 'present', point });
  if (minuteIdx >= 0) {
    for (let k = 1; k <= FUNDING_STALE_GRACE_BARS; k += 1) {
      const m = gridTs[minuteIdx - k];
      if (m !== undefined && fundingCol.covered(m)) return Object.freeze({ state: 'stale', point });
    }
  }
  return Object.freeze({ state: 'missing' });
}

/** Запрещённые маркеры expected-output источника (§8/R8). Любой присутствующий → `non_market_source`. */
const FORBIDDEN_SOURCE_KEYS = [
  'trades',
  'fills',
  'orders',
  'decisionRecords',
  'pnl',
  'labels',
  'positionTrail',
  'tradeEvents',
] as const;

/** Известные рыночные ключи per-symbol колонок (§10). Иные ключи → источник не raw-market. 030: +funding/taker. */
const ALLOWED_SYMBOL_KEYS: ReadonlySet<string> = new Set(['bars', 'oi', 'liq', 'funding', 'taker']);

/** Детерминированный порядок kind'ов в `CoverageModel` (§4). 030: +funding/taker (append). */
const COVERAGE_KIND_ORDER: readonly MarketDataKind[] = ['openInterest', 'liquidations', 'funding', 'taker'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function reject(detail: string): TapeBuildResult {
  return { ok: false, reason: 'non_market_source', detail };
}

/** Минутно-выровненная колонка снимков поверх Map<minuteTs, snapshot> (§1.2/§4). */
function minuteColumn<T>(byMinute: ReadonlyMap<number, T>): MinuteColumn<T> {
  return {
    at: (minuteTs) => byMinute.get(minuteTs),
    covered: (minuteTs) => byMinute.has(minuteTs),
  };
}

/** Непрерывные окна непокрытых минут грид-сетки бара (§4, детерминированный порядок). `covered` — предикат. */
function computeGaps(gridTs: readonly number[], covered: (ts: number) => boolean): MarketDataGap[] {
  const gaps: MarketDataGap[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  for (const ts of gridTs) {
    if (covered(ts)) {
      if (runStart !== null && runEnd !== null) gaps.push({ tsFrom: runStart, tsTo: runEnd });
      runStart = null;
      runEnd = null;
    } else {
      if (runStart === null) runStart = ts;
      runEnd = ts;
    }
  }
  if (runStart !== null && runEnd !== null) gaps.push({ tsFrom: runStart, tsTo: runEnd });
  return gaps;
}

/** Внутреннее per-symbol представление материализованной ленты. */
interface SymbolColumns {
  readonly bars: readonly Readonly<Bar>[];
  /** undefined ⇔ лента НЕ несёт OI для символа (kind отсутствует). */
  readonly oi?: ReadonlyMap<number, Readonly<OpenInterestSnapshot>>;
  /** undefined ⇔ лента НЕ несёт liquidations для символа. */
  readonly liq?: ReadonlyMap<number, Readonly<LiquidationSnapshot>>;
  /**
   * 030 — funding: **dense** массив (по снимку на каждую funding-покрытую минуту, live-forward),
   * отсортирован по ts. undefined ⇔ лента НЕ несёт funding. Дедуп в change-points + coverage — в
   * `buildFundingColumn` при материализации (R6).
   */
  readonly funding?: readonly Readonly<FundingSnapshot>[];
  /** 030 — taker: **per-minute** Map (как oi/liq); undefined ⇔ лента НЕ несёт taker. */
  readonly taker?: ReadonlyMap<number, Readonly<TakerSnapshot>>;
}

/**
 * 030 — funding-колонка (R6): live-forward as-of поверх sparse change-point снимков + dense coverage.
 * Вход — dense funding (снимок на каждую покрытую минуту) + `gridTs` (минутная сетка бара). Выход:
 *  - `column.at(t)` = последний change-point снимок с `ts ≤ t` (live-forward held rate);
 *  - `column.covered(t)` = минута `t` funding-покрыта (`has_funding=true`);
 *  - `changePoints` — sparse, для `toTape()`. Change-point создаётся при:
 *    (а) первой present-минуте; (б) изменении `fundingRate`; (в) **возобновлении покрытия после gap**
 *    (даже с тем же rate — рейт начинает держаться заново, freshness-anchor = минута resume).
 */
function buildFundingColumn(
  dense: readonly Readonly<FundingSnapshot>[],
  gridTs: readonly number[],
): {
  readonly column: MinuteColumn<FundingSnapshot>;
  readonly changePoints: readonly Readonly<FundingSnapshot>[];
} {
  const coverage = new Set<number>(dense.map((s) => s.ts));
  const snapByTs = new Map<number, Readonly<FundingSnapshot>>(dense.map((s) => [s.ts, s]));
  // Минутный таймлайн = объединение сетки бара и покрытых funding-минут (на случай funding-ts вне сетки),
  // по возрастанию. «Missing minute» = минута таймлайна без funding-покрытия (разрыв непрерывности).
  const timeline = [...new Set<number>([...gridTs, ...coverage])].sort((a, b) => a - b);
  const changePoints: Readonly<FundingSnapshot>[] = [];
  let prevCovered = false;
  let lastRate: number | undefined;
  for (const ts of timeline) {
    if (!coverage.has(ts)) {
      prevCovered = false; // gap → следующая покрытая минута будет resume change-point
      continue;
    }
    const snap = snapByTs.get(ts);
    if (snap === undefined) continue;
    // change-point: первая present-минута / resume после gap (!prevCovered) ИЛИ изменение rate.
    if (!prevCovered || lastRate !== snap.fundingRate) changePoints.push(snap);
    prevCovered = true;
    lastRate = snap.fundingRate;
  }
  const at = (minuteTs: number): FundingSnapshot | undefined => {
    // Последний change-point с ts ≤ minuteTs (бинарный поиск по возрастающему changePoints).
    let lo = 0;
    let hi = changePoints.length - 1;
    let found: Readonly<FundingSnapshot> | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (changePoints[mid].ts <= minuteTs) {
        found = changePoints[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  return {
    column: { at, covered: (minuteTs) => coverage.has(minuteTs) },
    changePoints: Object.freeze(changePoints),
  };
}

/** Предикат покрытия минуты для kind (undefined ⇔ лента НЕ несёт kind для символа). */
function coveredPredicate(kind: MarketDataKind, cols: SymbolColumns): ((ts: number) => boolean) | undefined {
  if (kind === 'openInterest') {
    const oi = cols.oi;
    return oi ? (ts) => oi.has(ts) : undefined;
  }
  if (kind === 'liquidations') {
    const liq = cols.liq;
    return liq ? (ts) => liq.has(ts) : undefined;
  }
  if (kind === 'funding') {
    if (cols.funding === undefined) return undefined;
    const set = new Set<number>(cols.funding.map((s) => s.ts));
    return (ts) => set.has(ts);
  }
  if (kind === 'taker') {
    const taker = cols.taker;
    return taker ? (ts) => taker.has(ts) : undefined;
  }
  return undefined;
}

/**
 * 030 (US4, FR-012/018) — per-(symbol,kind) coverage-state funding/taker по as-of перспективе на конце
 * периода (`t_end`): `present` (покрыто на t_end, вкл. present-zero) / `stale` (funding: за краем покрытия
 * в пределах grace) / `missing` (поддержан, нет покрытия на t_end / нет данных). `unsupported` решается
 * выше (platform-level из supported-набора), не здесь. taker `stale` (незавершённый бакет) над
 * финализированным каноном не возникает → present|missing.
 */
function coverageStateAtEnd(
  kind: MarketDataKind,
  gridTs: readonly number[],
  covered: (ts: number) => boolean,
  coveredMinutes: number,
): MarketDataCoverageState {
  if (gridTs.length === 0 || coveredMinutes === 0) return 'missing';
  const idxEnd = gridTs.length - 1;
  if (covered(gridTs[idxEnd])) return 'present';
  if (kind === 'funding') {
    for (let k = 1; k <= FUNDING_STALE_GRACE_BARS; k += 1) {
      const m = gridTs[idxEnd - k];
      if (m !== undefined && covered(m)) return 'stale';
    }
  }
  return 'missing';
}

function kindCoverage(symbol: string, kind: MarketDataKind, cols: SymbolColumns): KindCoverage {
  const gridTs = cols.bars.map((b) => b.ts);
  const isFundingOrTaker = kind === 'funding' || kind === 'taker';
  // unsupported = kind не в platform supported-наборе (FR-018: из supported-набора, НЕ per-source).
  // funding/taker ∈ SUPPORTED → `unsupported` для них не срабатывает (но таксономия его представляет).
  const supported = SUPPORTED_MARKET_DATA_KINDS.includes(kind);
  const covered = coveredPredicate(kind, cols);

  if (covered === undefined) {
    // Kind не несётся вовсе → полностью непокрыт (кандидат на missing_required, R6/US4).
    const gaps: readonly MarketDataGap[] =
      gridTs.length > 0 ? [{ tsFrom: gridTs[0], tsTo: gridTs[gridTs.length - 1] }] : [];
    const base = { symbol, kind, present: false, coveredMinutes: 0, gapMinutes: gridTs.length, gaps };
    return isFundingOrTaker ? { ...base, state: supported ? 'missing' : 'unsupported' } : base;
  }
  let coveredMinutes = 0;
  for (const ts of gridTs) if (covered(ts)) coveredMinutes += 1;
  const base = {
    symbol,
    kind,
    present: true,
    coveredMinutes,
    gapMinutes: gridTs.length - coveredMinutes,
    gaps: computeGaps(gridTs, covered),
  };
  if (!isFundingOrTaker) return base;
  const state: MarketDataCoverageState = supported ? coverageStateAtEnd(kind, gridTs, covered, coveredMinutes) : 'unsupported';
  return { ...base, state };
}

/** Материализовать `MarketTapeDataset` из проверенного per-symbol представления. */
function materialize(
  datasetRef: string,
  timeframe: string,
  bySymbol: ReadonlyMap<string, SymbolColumns>,
): MarketTapeDataset {
  const symbols = [...bySymbol.keys()].sort();

  const requireSymbol = (symbol: string): SymbolColumns => {
    const cols = bySymbol.get(symbol);
    if (cols === undefined) throw new Error(`MarketTapeDataset: unknown symbol "${symbol}" in "${datasetRef}"`);
    return cols;
  };

  // 030: precompute funding (live-forward column + sparse change-points) и taker (per-minute) колонки
  // один раз на символ (а не на каждый вызов accessor'а). undefined ⇔ kind не несётся.
  const fundingArtifacts = new Map<string, ReturnType<typeof buildFundingColumn>>();
  const takerColumns = new Map<string, MinuteColumn<TakerSnapshot>>();
  for (const symbol of symbols) {
    const cols = requireSymbol(symbol);
    if (cols.funding !== undefined) fundingArtifacts.set(symbol, buildFundingColumn(cols.funding, cols.bars.map((b) => b.ts)));
    if (cols.taker !== undefined) takerColumns.set(symbol, minuteColumn(cols.taker));
  }

  return {
    datasetRef,
    timeframe,
    symbols: () => symbols,
    candles: (symbol) => requireSymbol(symbol).bars,
    openInterest: (symbol) => {
      const oi = requireSymbol(symbol).oi;
      return oi === undefined ? undefined : minuteColumn(oi);
    },
    liquidations: (symbol) => {
      const liq = requireSymbol(symbol).liq;
      return liq === undefined ? undefined : minuteColumn(liq);
    },
    // 030 US1/US2: funding — live-forward as-of колонка (sparse change-points + dense coverage);
    // taker — per-minute exact (как oi/liq). undefined ⇔ лента не несёт kind (composition-following).
    funding: (symbol) => {
      requireSymbol(symbol); // validate symbol membership (consistent error with oi/liq)
      return fundingArtifacts.get(symbol)?.column;
    },
    taker: (symbol) => {
      requireSymbol(symbol);
      return takerColumns.get(symbol);
    },
    coverage: (): CoverageModel => {
      const entries: KindCoverage[] = [];
      for (const symbol of symbols) {
        const cols = requireSymbol(symbol);
        for (const kind of COVERAGE_KIND_ORDER) entries.push(kindCoverage(symbol, kind, cols));
      }
      return { entries };
    },
    toTape: (): MarketTape => {
      const events: MarketTapeEvent[] = [];
      for (const symbol of symbols) {
        const cols = requireSymbol(symbol);
        for (const bar of cols.bars) events.push({ kind: 'bar_close', symbol, ts: bar.ts, bar });
        if (cols.oi !== undefined) {
          for (const oi of cols.oi.values()) events.push({ kind: 'oi_snapshot', symbol, ts: oi.ts, oi });
        }
        if (cols.liq !== undefined) {
          for (const liq of cols.liq.values()) events.push({ kind: 'liq_snapshot', symbol, ts: liq.ts, liq });
        }
        // 030: funding — SPARSE (change-point снимки, live-forward повторы НЕ эмитятся как события).
        const fundingArt = fundingArtifacts.get(symbol);
        if (fundingArt !== undefined) {
          for (const funding of fundingArt.changePoints) events.push({ kind: 'funding_snapshot', symbol, ts: funding.ts, funding });
        }
        // 030: taker — DENSE (per-minute бакет на каждой покрытой минуте).
        if (cols.taker !== undefined) {
          for (const taker of cols.taker.values()) events.push({ kind: 'taker_snapshot', symbol, ts: taker.ts, taker });
        }
      }
      events.sort(compareMarketTapeEvents);
      return Object.freeze({ datasetRef, timeframe, symbols, events: Object.freeze(events) });
    },
  };
}

/** Заморозить и проиндексировать минутные снимки по `ts` (последний снимок минуты выигрывает). */
function indexByMinute<T extends { readonly ts: number }>(snapshots: readonly T[]): Map<number, Readonly<T>> {
  const map = new Map<number, Readonly<T>>();
  for (const s of snapshots) map.set(s.ts, Object.freeze(s));
  return map;
}

/**
 * Построить материализованную ленту из источника. Guard'ит источник (§8/R8): принимает ТОЛЬКО
 * raw-market дискриминатор `kind:'market_tape'` и известные рыночные поля; любой expected-output
 * маркер/неизвестный ключ → `{ ok:false, reason:'non_market_source', detail }`.
 */
export function buildMarketTape(source: unknown): TapeBuildResult {
  const root = asRecord(source);
  if (root === null) return reject('источник не является объектом raw-market ленты');
  if (root.kind !== 'market_tape') {
    return reject(`отсутствует/неверный raw-market дискриминатор kind (ожидался 'market_tape', получено ${String(root.kind)})`);
  }
  for (const key of FORBIDDEN_SOURCE_KEYS) {
    if (key in root) return reject(`источник несёт запрещённый expected-output маркер: ${key}`);
  }
  const datasetRef = typeof root.datasetRef === 'string' ? root.datasetRef : '';
  const timeframe = typeof root.timeframe === 'string' ? root.timeframe : '';
  if (datasetRef === '' || timeframe === '') return reject('источник без datasetRef/timeframe');

  const symbolsRec = asRecord(root.symbols);
  if (symbolsRec === null) return reject('источник без карты symbols');

  const bySymbol = new Map<string, SymbolColumns>();
  for (const [symbol, rawCols] of Object.entries(symbolsRec)) {
    const colsRec = asRecord(rawCols);
    if (colsRec === null) return reject(`колонки символа "${symbol}" не объект`);
    for (const key of Object.keys(colsRec)) {
      if (FORBIDDEN_SOURCE_KEYS.includes(key as (typeof FORBIDDEN_SOURCE_KEYS)[number])) {
        return reject(`символ "${symbol}" несёт запрещённый expected-output маркер: ${key}`);
      }
      if (!ALLOWED_SYMBOL_KEYS.has(key)) {
        return reject(`символ "${symbol}" несёт неизвестное рыночное поле: ${key}`);
      }
    }
    const bars = Array.isArray(colsRec.bars) ? (colsRec.bars as readonly Bar[]) : [];
    const frozenBars = Object.freeze(bars.map((b) => Object.freeze({ ...b })));
    const cols: SymbolColumns = {
      bars: frozenBars,
      ...(Array.isArray(colsRec.oi)
        ? { oi: indexByMinute(colsRec.oi as readonly OpenInterestSnapshot[]) }
        : {}),
      ...(Array.isArray(colsRec.liq)
        ? { liq: indexByMinute(colsRec.liq as readonly LiquidationSnapshot[]) }
        : {}),
      // 030: funding — dense frozen массив (дедуп/coverage в buildFundingColumn); taker — per-minute Map.
      ...(Array.isArray(colsRec.funding)
        ? { funding: Object.freeze((colsRec.funding as readonly FundingSnapshot[]).map((f) => Object.freeze({ ...f }))) }
        : {}),
      ...(Array.isArray(colsRec.taker)
        ? { taker: indexByMinute(colsRec.taker as readonly TakerSnapshot[]) }
        : {}),
    };
    bySymbol.set(symbol, cols);
  }

  return { ok: true, tape: materialize(datasetRef, timeframe, bySymbol) };
}

/**
 * Adapter из 010/027/028 `CanonicalRow`/`CanonicalRowV2` (research R11): чистый маппинг строк хранилища
 * в raw-market источник, затем `buildMarketTape`. Caller предоставляет уже прочитанные строки (через
 * `HistoricalDatasetReader`); сам reader/Postgres здесь НЕ импортируется (research-only граница, FR-020/021).
 * Маппинг: `oiTotalUsd=oi_total_usd` (⇔ `has_oi`); `longUsd=liq_long_usd`/`shortUsd=liq_short_usd`
 * (⇔ `has_liquidations`).
 * 030 (un-drop): `fundingRate=funding_rate` (⇔ `has_funding`; 0/<0 валидны) — dense, дедуп в материализации;
 * `buyUsd=taker_buy_volume_usd`/`sellUsd=taker_sell_volume_usd` (⇔ `has_taker_flow`, только v2; present-zero
 * валиден) — dense per-minute. Никаких новых canonical-полей (FR-017); funding/taker читаются из существующих.
 */
export function marketTapeFromCanonicalRows(
  datasetRef: string,
  timeframe: string,
  rows: readonly (CanonicalRow | CanonicalRowV2)[],
): TapeBuildResult {
  const symbols: Record<
    string,
    { bars: Bar[]; oi: OpenInterestSnapshot[]; liq: LiquidationSnapshot[]; funding: FundingSnapshot[]; taker: TakerSnapshot[] }
  > = {};
  let anyOi = false;
  let anyLiq = false;
  let anyFunding = false;
  let anyTaker = false;
  for (const r of rows) {
    const bucket = (symbols[r.symbol] ??= { bars: [], oi: [], liq: [], funding: [], taker: [] });
    bucket.bars.push({ ts: r.minute_ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
    if (r.has_oi && r.oi_total_usd !== null) {
      bucket.oi.push({ ts: r.minute_ts, oiTotalUsd: r.oi_total_usd });
      anyOi = true;
    }
    if (r.has_liquidations && r.liq_long_usd !== null && r.liq_short_usd !== null) {
      bucket.liq.push({ ts: r.minute_ts, longUsd: r.liq_long_usd, shortUsd: r.liq_short_usd });
      anyLiq = true;
    }
    // 030: funding (dense; 0/<0 — валидные present-наблюдения). Доступно на v1 и v2.
    if (r.has_funding && r.funding_rate !== null) {
      bucket.funding.push({ ts: r.minute_ts, fundingRate: r.funding_rate });
      anyFunding = true;
    }
    // 030: taker (dense per-minute; present-zero {0,0} валиден). Только v2 (taker-триплет).
    if (r.schema_version === 2 && r.has_taker_flow && r.taker_buy_volume_usd !== null && r.taker_sell_volume_usd !== null) {
      bucket.taker.push({ ts: r.minute_ts, buyUsd: r.taker_buy_volume_usd, sellUsd: r.taker_sell_volume_usd });
      anyTaker = true;
    }
  }
  // Колонку kind включаем только если он несётся хотя бы одной строкой (composition-following, как oi/liq).
  const source: RawMarketTapeSource = {
    kind: 'market_tape',
    datasetRef,
    timeframe,
    symbols: Object.fromEntries(
      Object.entries(symbols).map(([sym, b]) => [
        sym,
        {
          bars: b.bars,
          ...(anyOi ? { oi: b.oi } : {}),
          ...(anyLiq ? { liq: b.liq } : {}),
          ...(anyFunding ? { funding: b.funding } : {}),
          ...(anyTaker ? { taker: b.taker } : {}),
        },
      ]),
    ),
  };
  return buildMarketTape(source);
}
