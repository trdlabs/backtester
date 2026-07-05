/**
 * 026 Long OI StrategyModule — чистые ported helpers (поведенческая карта legacy `dump_long`).
 *
 * Порт (НЕ импорт) из `src/strategies/dump_long/{detector,rules,fail_fast}.ts` + `src/shared/utils.ts`
 * (forbidden-boundary запрещает импорт legacy; единый источник alpha-логики). Чистые функции:
 * вход — уже извлечённые из ctx скаляры/массивы, выход — детерминированные оценки. Без I/O/ctx-мутаций.
 *
 * **Не портируются** (host-owned / default-off, исключены из module-params — params-schema.md):
 * postSpikeCascade/extremeReboundThinSupport guards, riskScoreScaler, failFast.entryGate suppress-подграф.
 */

import type { Bar, StrategyContext } from '@trading-platform/sdk/research-contract';
import type { OiPoint } from '@trading-platform/sdk/research-contract';
import { DEFAULT_PARAMS, type LongOiParams } from './params.js';
import type { LongOiWatchSignal } from './state.js';

// ───────────────────────────────────────────────────────────────────────────
// Резолв параметров + извлечение рыночных поверхностей из ctx (C1-деградация)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Резолв `LongOiParams` из `ctx.params`. Манифест несёт `DEFAULT_PARAMS`; раннер/хост передают полный
 * объект через `ctx.params`. Если поверхность неполна (отсутствует ключевая группа) → `DEFAULT_PARAMS`
 * (детерминированный fallback, без частично-неопределённого поведения).
 */
export function resolveParams(ctx: StrategyContext): LongOiParams {
  const p = ctx.params as Partial<LongOiParams> | undefined;
  if (p && p.tpLadder && p.protection && p.dca && p.dump && p.watch && p.entry && p.oiFilter && p.liqFilter && p.warmup && p.failFast) {
    return p as LongOiParams;
  }
  return DEFAULT_PARAMS;
}

/**
 * Последние 3 OI-тотала, заканчивающиеся на текущей минуте включительно (`ctx.market.oiWindow(3)`).
 * **C1**: `ctx.market` отсутствует (OHLCV-only) ИЛИ любой слот окна `undefined` (gap, carry-forward
 * запрещён) ИЛИ окна < 3 → `null` (no-throw / no-zero-substitution).
 */
export function oiWindow3(ctx: StrategyContext): number[] | null {
  const m = ctx.market;
  if (m === undefined) return null;
  const w = m.oiWindow(3);
  if (w.length < 3) return null;
  const out: number[] = [];
  for (const slot of w) {
    if (slot === undefined) return null;
    out.push((slot as OiPoint).oiTotalUsd);
  }
  return out;
}

/**
 * Long-ликвидации текущей минуты (`ctx.market.liqAsOf().longUsd`). **C1**: `ctx.market` отсутствует ИЛИ
 * gap (`liqAsOf()===undefined`) → `null`. covered-no-events → `0` (НЕ деградация — валидный «нет
 * ликвидаций»). Carry-forward запрещён.
 */
export function liqLongNow(ctx: StrategyContext): number | null {
  const m = ctx.market;
  if (m === undefined) return null;
  const liq = m.liqAsOf();
  if (liq === undefined) return null;
  return liq.longUsd;
}

// ───────────────────────────────────────────────────────────────────────────
// Math helpers (порт src/shared/utils.ts + detector локальные)
// ───────────────────────────────────────────────────────────────────────────

/** `(a-b)/b*100`; `b==0` → 0 (порт `pctChange`). */
export function pctChange(a: number, b: number): number {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/** Падение from→to в % (порт detector `pctDrop`); невалидный/неположительный from → 0. */
export function pctDrop(from: number, to: number): number {
  const a = Number(from || 0);
  const b = Number(to || 0);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b)) return 0;
  return ((a - b) / a) * 100;
}

/** Рост from→to в % (порт detector `pctRise`). */
export function pctRise(from: number, to: number): number {
  const a = Number(from || 0);
  const b = Number(to || 0);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b)) return 0;
  return ((b - a) / a) * 100;
}

/** Число «зелёных» переходов close[i] > close[i-1] (порт rules `countGreenCandles`). */
export function countGreenCandles(prices: readonly Bar[]): number {
  let count = 0;
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i].close > prices[i - 1].close) count += 1;
  }
  return count;
}

/**
 * Последние `n` закрытых свечей, ВКЛЮЧАЯ текущий бар (`ctx.bar`). Зеркалит legacy, где приходящая
 * свеча уже добавлена в series. `closedCandles(n-1)` строго до `t` + `ctx.bar` (бар `t`).
 */
export function recentCandles(ctx: StrategyContext, n: number): Bar[] {
  if (n <= 1) return [ctx.bar];
  const prior = ctx.data.closedCandles(n - 1);
  return [...prior, ctx.bar];
}

// ───────────────────────────────────────────────────────────────────────────
// Dump-детект (порт detector.ts: open_to_close + high_to_low)
// ───────────────────────────────────────────────────────────────────────────

function findHighest(candles: readonly Bar[]): { high: number; ts: number } | null {
  let best: { high: number; ts: number } | null = null;
  for (const c of candles) {
    const high = Number(c?.high || 0);
    if (!Number.isFinite(high) || high <= 0) continue;
    if (!best || high > best.high) best = { high, ts: Number(c.ts || 0) };
  }
  return best;
}

function findLowest(candles: readonly Bar[]): { low: number; ts: number } | null {
  let best: { low: number; ts: number } | null = null;
  for (const c of candles) {
    const low = Number(c?.low || 0);
    if (!Number.isFinite(low) || low <= 0) continue;
    if (!best || low < best.low) best = { low, ts: Number(c.ts || 0) };
  }
  return best;
}

function detectOpenToClose(window: readonly Bar[], p: LongOiParams): LongOiWatchSignal | null {
  if (window.length < 2) return null;
  const first = window[0];
  const last = window[window.length - 1];
  const firstOpen = Number(first?.open || 0);
  const lastClose = Number(last?.close || 0);
  const dumpPctOpenClose = pctDrop(firstOpen, lastClose);
  if (dumpPctOpenClose < p.dump.minDropPct) return null;
  const lowInfo = findLowest(window);
  const highInfo = findHighest(window);
  return {
    ts: Number(last.ts || 0),
    signalPrice: lastClose,
    triggerMode: 'open_to_close',
    triggerPct: dumpPctOpenClose,
    dumpPctOpenClose,
    dumpPctHighLow: highInfo && lowInfo ? pctDrop(highInfo.high, lowInfo.low) : 0,
    highest: Number(highInfo?.high || 0),
    highestTs: Number(highInfo?.ts || 0),
    lowest: Number(lowInfo?.low || 0),
    lowTs: Number(lowInfo?.ts || 0),
    bounceFromLowPct: lowInfo ? pctRise(lowInfo.low, lastClose) : 0,
    firstOpen,
    lastClose,
  };
}

function detectHighToLow(window: readonly Bar[], p: LongOiParams): LongOiWatchSignal | null {
  if (window.length < 2) return null;
  const minDropPct = p.dump.minDropPct;
  const closeHoldMinPct = p.dump.highToLowMinCloseHoldPct;
  const maxGreenRecoveryBouncePct = p.dump.highToLowMaxGreenRecoveryBouncePct;
  const maxClosePosInRangePct = p.dump.highToLowMaxClosePosInRangePct;

  let highestIdx = -1;
  let highest = -Infinity;
  for (let i = 0; i < window.length; i += 1) {
    const high = Number(window[i]?.high || 0);
    if (Number.isFinite(high) && high > highest) {
      highest = high;
      highestIdx = i;
    }
  }
  if (highestIdx < 0) return null;

  let lowestIdx = -1;
  let lowest = Infinity;
  for (let i = highestIdx; i < window.length; i += 1) {
    const low = Number(window[i]?.low || 0);
    if (Number.isFinite(low) && low > 0 && low < lowest) {
      lowest = low;
      lowestIdx = i;
    }
  }
  if (lowestIdx < 0) return null;

  const lowCandle = window[lowestIdx];
  const last = window[window.length - 1];
  const lastClose = Number(last?.close || 0);
  const lowOpen = Number(lowCandle?.open || 0);
  const lowHigh = Number(lowCandle?.high || 0);
  const lowLow = Number(lowCandle?.low || 0);
  const lowClose = Number(lowCandle?.close || 0);

  const dumpPctHighLow = pctDrop(highest, lowest);
  const dumpPctHighToClose = pctDrop(highest, lastClose);
  const bounceFromLowPct = pctRise(lowest, lastClose);

  if (dumpPctHighLow < minDropPct) return null;

  const range = Math.max(lowHigh - lowLow, 0);
  const closePosInRangePct = range > 0 ? ((lowClose - lowLow) / range) * 100 : 0;
  const isGreenLowCandle = lowClose >= lowOpen;

  if (dumpPctHighToClose < closeHoldMinPct) return null;
  if (closePosInRangePct > maxClosePosInRangePct) return null;
  if (isGreenLowCandle && bounceFromLowPct > maxGreenRecoveryBouncePct) return null;

  return {
    ts: Number(last.ts || 0),
    signalPrice: lastClose,
    triggerMode: 'high_to_low',
    triggerPct: dumpPctHighLow,
    dumpPctOpenClose: pctDrop(Number(window[0]?.open || 0), lastClose),
    dumpPctHighLow,
    highest: Number(highest || 0),
    highestTs: Number(window[highestIdx]?.ts || 0),
    lowest: Number(lowest || 0),
    lowTs: Number(lowCandle?.ts || 0),
    bounceFromLowPct,
    firstOpen: Number(window[0]?.open || 0),
    lastClose,
  };
}

/** Детект dump над окном последних `lookbackMin` свечей (порт `detectDump`). */
export function detectDump(klines: readonly Bar[], p: LongOiParams): LongOiWatchSignal | null {
  const lookbackMin = p.dump.lookbackMin;
  if (klines.length < 2 || lookbackMin < 2) return null;
  const window = klines.slice(-lookbackMin);
  return p.dump.triggerMode === 'high_to_low' ? detectHighToLow(window, p) : detectOpenToClose(window, p);
}

// ───────────────────────────────────────────────────────────────────────────
// Entry-проверка (порт rules `entryCheck`, БЕЗ cascade guards)
// ───────────────────────────────────────────────────────────────────────────

export interface EntryInputs {
  /** Последние 3 свечи, включая текущую (index 2 = текущая). */
  candles3: readonly Bar[];
  /** Последние 3 OI-тотала (index 2 = текущий минут). */
  oi3: readonly number[];
  /** Long-ликвидации текущей минуты (USD). */
  liqLongUsd: number;
  /** Текущий OI-тотал (для liqRatioPct). */
  oiNow: number;
  /** `watch.localLowAfterSignal`. */
  localLow: number;
}

export interface EntryEval {
  ok: boolean;
  reason?: string;
  fastEntry: boolean;
  oiRecovery: number;
  bouncePct: number;
  liqUsd: number;
  liqRatioPct: number;
  fastCandlePct: number;
  greenCandles: number;
}

/** `liqRatioPct = longUsd/oiTotalUsd*100` (зеркалит market_aggregator.ts:533). */
export function liqRatioPctOf(liqLongUsd: number, oiTotalUsd: number): number {
  return oiTotalUsd > 0 ? (liqLongUsd / oiTotalUsd) * 100 : 0;
}

export function evaluateEntry(inp: EntryInputs, p: LongOiParams): EntryEval {
  const prices = inp.candles3;
  const bouncePct = pctChange(prices[2].close, inp.localLow || prices[2].close);
  const fastCandlePct = pctChange(prices[2].close, prices[1].close);
  const fastEntry = fastCandlePct >= p.entry.fastBouncePct;
  const greenCandles = countGreenCandles(prices);
  const priceUpEnough = fastEntry || greenCandles >= p.entry.requireGreenPriceCandles;

  const oiRecovery = fastEntry ? pctChange(inp.oi3[2], inp.oi3[1]) : pctChange(inp.oi3[2], inp.oi3[0]);
  const liqUsd = inp.liqLongUsd;
  const liqRatioPct = liqRatioPctOf(liqUsd, inp.oiNow);
  const base = { fastEntry, oiRecovery, bouncePct, liqUsd, liqRatioPct, fastCandlePct, greenCandles };

  if (!priceUpEnough) return { ok: false, reason: 'price_not_rising_2m', ...base };
  if (oiRecovery < p.oiFilter.entryMinOiRecoveryPct2m) return { ok: false, reason: 'oi_not_recovered', ...base };
  if (bouncePct < p.entry.minBouncePctFromLow) return { ok: false, reason: 'bounce_too_small', ...base };
  if (p.liqFilter.requireLiquidation) {
    if (liqUsd <= 0) return { ok: false, reason: 'no_liquidations', ...base };
    if (liqRatioPct < p.liqFilter.minLongLiqOiRatioPct) return { ok: false, reason: 'liq_ratio_too_small', ...base };
  }
  return { ok: true, ...base };
}

// ───────────────────────────────────────────────────────────────────────────
// DCA-проверка (порт rules `dcaCheck`)
// ───────────────────────────────────────────────────────────────────────────

export interface DcaInputs {
  candles3: readonly Bar[];
  oi3: readonly number[];
  /** `miniWatch.localLowAfterSignal`. */
  localLow: number;
  /** Текущая цена (close бара). */
  currentPrice: number;
  /** Уже выполненных доливок. */
  dcaCount: number;
}

export interface DcaEval {
  ok: boolean;
  reason?: string;
  fastEntry: boolean;
  oiRecovery: number;
  bouncePct: number;
  fastCandlePct: number;
  greenCandles: number;
}

export function evaluateDca(inp: DcaInputs, p: LongOiParams): DcaEval {
  const prices = inp.candles3;
  const fastCandlePct = pctChange(prices[2].close, prices[1].close);
  const greenCandles = countGreenCandles(prices);
  const fastEntry = fastCandlePct >= p.dca.reconfirm.fastBouncePct;
  const bouncePct = pctChange(inp.currentPrice, inp.localLow || inp.currentPrice);
  const oiRecovery = fastEntry ? pctChange(inp.oi3[2], inp.oi3[1]) : pctChange(inp.oi3[2], inp.oi3[0]);
  const base = { fastEntry, oiRecovery, bouncePct, fastCandlePct, greenCandles };

  if (inp.dcaCount >= p.dca.maxAdds) return { ok: false, reason: 'dca_limit_reached', ...base };
  const priceUpEnough = fastEntry || greenCandles >= p.dca.reconfirm.requireGreenCandles;
  if (!priceUpEnough) return { ok: false, reason: 'price_not_rising_2m', ...base };
  if (oiRecovery < p.dca.reconfirm.minOiRecoveryPct2m) return { ok: false, reason: 'oi_not_recovered', ...base };
  if (bouncePct < p.dca.reconfirm.minBouncePctFromNewLow) return { ok: false, reason: 'bounce_too_small', ...base };
  return { ok: true, ...base };
}

// ───────────────────────────────────────────────────────────────────────────
// Exit-предикаты (порт rules `shouldTakeTp`/`shouldHardStop`)
// ───────────────────────────────────────────────────────────────────────────

/** TP-достижение: `pctChange(currentPrice, entryPrice) >= pct`. */
export function shouldTakeTp(entryPrice: number, currentPrice: number, pct: number): boolean {
  if (!Number.isFinite(Number(entryPrice)) || !Number.isFinite(Number(currentPrice))) return false;
  return pctChange(currentPrice, entryPrice) >= pct;
}

/** Hard-stop: `pctChange(currentPrice, entryPrice) <= -pct`. */
export function shouldHardStop(entryPrice: number, currentPrice: number, pct: number): boolean {
  if (!Number.isFinite(Number(entryPrice)) || !Number.isFinite(Number(currentPrice))) return false;
  return pctChange(currentPrice, entryPrice) <= -pct;
}

// ───────────────────────────────────────────────────────────────────────────
// Fail-fast (порт core `evaluateFailFastExit`, БЕЗ entryGate suppress-подграфа)
// ───────────────────────────────────────────────────────────────────────────

function greenBodyPct(c: Bar): number {
  const o = Number(c?.open || 0);
  const cl = Number(c?.close || 0);
  if (o <= 0 || cl <= o) return 0;
  return ((cl - o) / o) * 100;
}

function sumGreenBodiesLast2(klines: readonly Bar[]): number | null {
  if (klines.length < 2) return null;
  return greenBodyPct(klines[klines.length - 2]) + greenBodyPct(klines[klines.length - 1]);
}

function closeDrift3Pct(klines: readonly Bar[]): number | null {
  if (klines.length < 4) return null;
  const closeNow = Number(klines[klines.length - 1].close || 0);
  const closeThreeBack = Number(klines[klines.length - 4].close || 0);
  if (closeThreeBack <= 0 || !Number.isFinite(closeNow)) return null;
  return ((closeNow - closeThreeBack) / closeThreeBack) * 100;
}

function countCandlesStrictlyAfterEntry(klines: readonly Bar[], openedAtTs: number): number {
  const t0 = Number(openedAtTs || 0);
  let n = 0;
  for (const k of klines) if (Number(k.ts) > t0) n += 1;
  return n;
}

function maxHighBouncePctSinceEntry(klines: readonly Bar[], openedAtTs: number, avgEntry: number): number | null {
  if (!Number.isFinite(avgEntry) || avgEntry <= 0) return null;
  const t0 = Number(openedAtTs || 0);
  let maxHigh = -Infinity;
  for (const k of klines) {
    if (Number(k.ts) < t0) continue;
    const hi = Number(k.high || 0);
    if (hi > maxHigh) maxHigh = hi;
  }
  if (!Number.isFinite(maxHigh) || maxHigh <= 0) return null;
  return ((maxHigh - avgEntry) / avgEntry) * 100;
}

export interface FailFastInputs {
  klines: readonly Bar[];
  avgEntry: number;
  openedAt: number;
  tp1Done: boolean;
  currentClose: number;
}

/**
 * Pre-TP1 защитный выход. Возвращает diagnostic-detail при срабатывании, иначе `null`. По дефолту
 * (`failFast.enabled=false`) сразу `null`. Порт core `evaluateFailFastExit` (PnL-USD оценка опущена —
 * qty host-owned; используется `pnlPctVsEntry`).
 */
export function evaluateFailFast(inp: FailFastInputs, p: LongOiParams): Record<string, number> | null {
  const ff = p.failFast;
  if (!ff.enabled) return null;
  if (inp.tp1Done) return null;
  const avgEntryPx = Number(inp.avgEntry || 0);
  if (!Number.isFinite(avgEntryPx) || avgEntryPx <= 0) return null;

  const candlesSinceEntry = countCandlesStrictlyAfterEntry(inp.klines, inp.openedAt);
  if (candlesSinceEntry < ff.minCandlesAfterEntry) return null;

  const bouncePct = maxHighBouncePctSinceEntry(inp.klines, inp.openedAt, avgEntryPx);
  if (bouncePct != null && bouncePct >= ff.skipIfBounceFromEntryPct) return null;

  const closeDrift3 = closeDrift3Pct(inp.klines);
  const sumGreenBodies2 = sumGreenBodiesLast2(inp.klines);
  if (closeDrift3 == null || sumGreenBodies2 == null) return null;
  if (!(sumGreenBodies2 < ff.maxSumGreenBodies2Pct)) return null;

  const pnlPctVsEntry = pctChange(inp.currentClose, avgEntryPx);

  let driftOk: boolean;
  if (ff.driftCompositeEnabled) {
    driftOk = closeDrift3 < ff.maxCloseDrift3Pct || (closeDrift3 < ff.compositeDriftSoftPct && pnlPctVsEntry < ff.compositeMinLossPctVsEntry);
  } else {
    driftOk = closeDrift3 < ff.maxCloseDrift3Pct;
  }
  if (!driftOk) return null;

  return { closeDrift3, sumGreenBodies2, candlesSinceEntry, pnlPctVsEntry, maxHighBounceSinceEntryPct: bouncePct ?? 0 };
}
