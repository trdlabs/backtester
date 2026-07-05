// 023 — point-in-time доступ к рыночным снимкам (US1, FR-006, US3-AC2, SC-008, research R3).
//
// `pointInTimeMarketApi(dataset, symbol, t)` строит read-only поверхность OI/liquidations на минуту `t`:
// `oiAsOf()/liqAsOf()` — снимок минуты `t` (gap → undefined; covered-0/0 → валидный `{0,0}`);
// `oiWindow(lookback)/liqWindow(lookback)` — окно минутных бакетов, заканчивающееся НА `t` ВКЛЮЧИТЕЛЬНО
// (gap-слоты → явный undefined, без carry-forward). НЕТ forward-методов (структурный no-lookahead).
// Все значения `ts ≤ t`; результат deep-frozen.
//
// 023 / US3 (детерминизм, FR-006/007/015/016, R7): чистая проекция поверх материализованной ленты —
// без `Date.now()`/`Math.random()`/host/temp/env; структурный no-lookahead подтверждён по построению
// (нет forward-методов; срезы `ts ≤ t`; результат deep-frozen). Машинно — `verify_023_determinism.mjs`.

import type {
  FundingPoint,
  FundingReading,
  LiqPoint,
  MarketTapeDataset,
  OiPoint,
  PointInTimeMarketApi,
  TakerPoint,
  TakerReading,
  TakerSnapshot,
} from '@trading/research-contracts/research';
// 030 — fundingReadingAt (единственный источник истины для stale-grace семантики) живёт в market-tape;
// market-access делегирует ей через импорт, чтобы reading-staleness и coverage-state не разъезжались.
import { fundingReadingAt } from './market-tape.js';

function oiPoint(snap: { readonly ts: number; readonly oiTotalUsd: number } | undefined): OiPoint | undefined {
  return snap === undefined ? undefined : Object.freeze({ ts: snap.ts, oiTotalUsd: snap.oiTotalUsd });
}

function liqPoint(
  snap: { readonly ts: number; readonly longUsd: number; readonly shortUsd: number } | undefined,
): LiqPoint | undefined {
  return snap === undefined ? undefined : Object.freeze({ ts: snap.ts, longUsd: snap.longUsd, shortUsd: snap.shortUsd });
}

function takerPoint(snap: TakerSnapshot): TakerPoint {
  return Object.freeze({ ts: snap.ts, buyUsd: snap.buyUsd, sellUsd: snap.sellUsd });
}

// DRIFT-GUARD: a verbatim copy of this function is vendored as the reference oracle in
// trading-platform/scripts/verify_093_window_parity.mjs (the long_oi ctx.market window-parity
// gate proving the live adapter's OI/liq/funding/taker windows match this calendar-grid
// contract). If you change the windowing semantics here, update that vendored copy / the
// platform gate — otherwise the platform-side parity check silently rots.
/** Минуты-бакеты `[..t]` ВКЛЮЧИТЕЛЬНО длиной `min(lookback, доступные [0..idx])`; `[]` при невалидном lookback. */
function windowMinutes(gridTs: readonly number[], idx: number, lookback: number): readonly number[] {
  if (idx < 0 || !Number.isInteger(lookback) || lookback <= 0) return [];
  const start = Math.max(0, idx - lookback + 1);
  return gridTs.slice(start, idx + 1);
}

/**
 * Построить PIT-рыночную поверхность на минуту `t` (= `bar.ts` текущего бара) для символа.
 * Минутная сетка берётся из свечей символа; gap → undefined (нет carry-forward); отсутствие kind в
 * ленте → `oiAsOf/liqAsOf` = undefined и окно = `[]`.
 */
export function pointInTimeMarketApi(
  dataset: MarketTapeDataset,
  symbol: string,
  t: number,
): PointInTimeMarketApi {
  const gridTs = dataset.candles(symbol).map((b) => b.ts);
  const idx = gridTs.indexOf(t);
  const oiCol = dataset.openInterest(symbol);
  const liqCol = dataset.liquidations(symbol);
  const fundingCol = dataset.funding(symbol);
  const takerCol = dataset.taker(symbol);

  // 030 — тонкая обёртка: логика stale-grace вынесена в market-tape.fundingReadingAt (единый источник истины).
  const fundingReadingAtLocal = (minuteTs: number, minuteIdx: number): FundingReading =>
    fundingReadingAt(fundingCol, gridTs, minuteTs, minuteIdx);

  const fundingAsOf = (): FundingReading => fundingReadingAtLocal(t, idx);

  /**
   * 030 — taker as-of бакет минуты `t` (FR-008/009/010). `present` ⟺ бакет существует (вкл. present-zero
   * `{0,0}`); `missing` ⟺ gap (нет бакета — БЕЗ carry-forward, не ноль). delta = `buyUsd − sellUsd` выводит
   * потребитель (не поле). `stale` (незавершённый бакет) над финализированным каноном не возникает.
   */
  const takerAsOf = (): TakerReading => {
    const p = takerCol === undefined || idx < 0 ? undefined : takerCol.at(t);
    if (p === undefined) return Object.freeze({ state: 'missing' });
    return Object.freeze({ state: 'present', point: takerPoint(p) });
  };

  /**
   * 030 — funding-окно (FR-011): per-minute **as-of live-forward**. Слот = `FundingPoint` чтения этой
   * минуты (present/stale → реальный снимок со своим `ts`, повторяется в соседних слотах до stale-boundary;
   * missing → undefined). Длина `min(lookback, доступные [0..t])`, конец на `t` включительно; нет forward.
   */
  const fundingWindow = (lookback: number): readonly (FundingPoint | undefined)[] => {
    if (fundingCol === undefined || idx < 0 || !Number.isInteger(lookback) || lookback <= 0) return Object.freeze([]);
    const start = Math.max(0, idx - lookback + 1);
    const out: (FundingPoint | undefined)[] = [];
    for (let j = start; j <= idx; j += 1) {
      const r = fundingReadingAtLocal(gridTs[j], j);
      out.push(r.state === 'missing' ? undefined : r.point);
    }
    return Object.freeze(out);
  };

  /**
   * 030 — taker-окно (FR-011): per-minute **exact**, БЕЗ carry-forward. Слот = бакет точно минуты
   * (`undefined` = gap; present-zero = реальная точка `{0,0}`). Длина `min(lookback, доступные [0..t])`,
   * конец на `t` включительно; нет forward. Намеренно отличается от funding-окна (без повтора).
   */
  const takerWindow = (lookback: number): readonly (TakerPoint | undefined)[] => {
    if (takerCol === undefined) return Object.freeze([]);
    return Object.freeze(windowMinutes(gridTs, idx, lookback).map((m) => {
      const p = takerCol.at(m);
      return p === undefined ? undefined : takerPoint(p);
    }));
  };

  // Composition-following (FR-014): funding/taker методы присутствуют ТОЛЬКО когда лента несёт kind →
  // OHLCV/OI/liq-only ленты сохраняют форму 023 контекста (SC-004).
  return Object.freeze({
    oiAsOf: () => (oiCol === undefined || idx < 0 ? undefined : oiPoint(oiCol.at(t))),
    liqAsOf: () => (liqCol === undefined || idx < 0 ? undefined : liqPoint(liqCol.at(t))),
    oiWindow: (lookback: number): readonly (OiPoint | undefined)[] => {
      if (oiCol === undefined) return Object.freeze([]);
      return Object.freeze(windowMinutes(gridTs, idx, lookback).map((m) => oiPoint(oiCol.at(m))));
    },
    liqWindow: (lookback: number): readonly (LiqPoint | undefined)[] => {
      if (liqCol === undefined) return Object.freeze([]);
      return Object.freeze(windowMinutes(gridTs, idx, lookback).map((m) => liqPoint(liqCol.at(m))));
    },
    ...(fundingCol !== undefined ? { fundingAsOf, fundingWindow } : {}),
    ...(takerCol !== undefined ? { takerAsOf, takerWindow } : {}),
  });
}
