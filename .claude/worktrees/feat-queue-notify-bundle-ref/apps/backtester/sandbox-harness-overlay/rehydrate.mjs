// 019/020 — ContextRehydrator (исполняется ВНУТРИ контейнера; US2; research R6/R10, data-model §5; FR-012/013).
//
// ContextSnapshot → deep-frozen 017 StrategyContext. САМОДОСТАТОЧЕН: никаких импортов из host src/dist/
// npm — session-seeded RNG вендорится здесь; индикаторы считает СКОПИРОВАННЫЙ движок из './_engine/'.
//
// 020 (T028): `ctx.indicators` строится тем же скомпилированным import-closed движком, что и trusted
// (`build:sandbox-harness` копирует dist/src/research/indicators/** → ./_engine/**). Один и тот же
// engine code path × один и тот же префикс закрытых свечей [0..t] ⇒ ТОЧНОЕ равенство trusted↔sandbox
// (FR-017/SC-002). Буфер закрытых свечей АККУМУЛИРУЕТСЯ из `newBar` (≤ t) — forward-свечей в sandbox
// физически нет (no-lookahead структурен и в контейнере).

import { createIndicatorEngine } from './_engine/engine.js';

/** mulberry32 — детерминированный 32-битный PRNG (вендорная копия 018 rng.ts). */
export function createSeededRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Рекурсивная заморозка (вендорная копия 018 context.ts deepFreeze). */
export function deepFreeze(obj) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = obj[key];
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * 023 — реконструкция point-in-time рыночной поверхности `ctx.market` из аккумулированных буферов
 * OI/liq (≤ t), self-contained (без host-импортов). Семантика ТОЧНО как trusted market-access.ts (§5):
 * `oiAsOf/liqAsOf` — снимок минуты t (null-слот = gap → undefined; covered-0/0 → {0,0}); окна
 * заканчиваются НА t ВКЛЮЧИТЕЛЬНО, gap-слоты → undefined (без carry-forward); нет forward-методов.
 * Буферы index-aligned со свечным буфером (подаются вместе с newBar). Пустые оба → kind'ов нет →
 * `ctx.market` отсутствует (OHLCV-only форма неизменна).
 */
function buildMarketAccess(oiBuffer, liqBuffer, t) {
  const hasOi = oiBuffer.length > 0;
  const hasLiq = liqBuffer.length > 0;
  if (!hasOi && !hasLiq) return undefined;
  const oiPoint = (s) => (s === null || s === undefined ? undefined : Object.freeze({ ts: s.ts, oiTotalUsd: s.oiTotalUsd }));
  const liqPoint = (s) => (s === null || s === undefined ? undefined : Object.freeze({ ts: s.ts, longUsd: s.longUsd, shortUsd: s.shortUsd }));
  const windowOf = (buf, lookback, toPoint) => {
    if (buf.length === 0 || !Number.isInteger(lookback) || lookback <= 0) return Object.freeze([]);
    const start = Math.max(0, t - lookback + 1);
    return Object.freeze(buf.slice(start, t + 1).map(toPoint));
  };
  return Object.freeze({
    oiAsOf: () => (hasOi ? oiPoint(oiBuffer[t]) : undefined),
    liqAsOf: () => (hasLiq ? liqPoint(liqBuffer[t]) : undefined),
    oiWindow: (lookback) => (hasOi ? windowOf(oiBuffer, lookback, oiPoint) : Object.freeze([])),
    liqWindow: (lookback) => (hasLiq ? windowOf(liqBuffer, lookback, liqPoint) : Object.freeze([])),
  });
}

/**
 * Регидрировать 017 StrategyContext из snapshot + аккумулированного буфера свечей (текущий бар —
 * последний в буфере). `data.closedCandles(lookback)` — строго ДО t; `clock.now()` = snapshot.clockNow;
 * `rng` — session-seeded. Результат deep-frozen (read-only инвариант 017).
 *
 * 020: `ctx.indicators` = `engine.accessorAt(t)` того же скомпилированного движка, что в trusted
 * (engine видит закрытые свечи буфера [0..t]). `value('sma',N)` и `indicatorAsOf('sma_<N>')` идут
 * через тот же движок ⇒ точное равенство с trusted.
 *
 * 023: `oiBuffer`/`liqBuffer` (по умолчанию пусты — back-compat) аккумулируют newOi/newLiq ≤ t;
 * `ctx.market` реконструируется из них (composition-following). OHLCV-only → буферы пусты → нет market.
 */
export function rehydrateContext(snapshot, buffer, rng, oiBuffer = [], liqBuffer = []) {
  const t = buffer.length - 1;
  const accessor = createIndicatorEngine(buffer).accessorAt(t);
  const data = {
    closedCandles(lookback) {
      const start = Math.max(0, t - lookback);
      return Object.freeze(buffer.slice(start, t).map((b) => Object.freeze({ ...b })));
    },
    indicatorAsOf(name) {
      const m = /^sma_(\d+)$/.exec(name);
      if (m !== null) return accessor.value('sma', Number(m[1]));
      return undefined;
    },
  };
  const market = buildMarketAccess(oiBuffer, liqBuffer, t);
  const ctx = {
    run: snapshot.run,
    params: snapshot.params,
    symbol: snapshot.symbol,
    bar: snapshot.bar,
    position: snapshot.position,
    pendingIntent: snapshot.pendingIntent,
    portfolio: snapshot.portfolio,
    clock: { now: () => snapshot.clockNow },
    data,
    indicators: accessor,
    rng: { next: () => rng.next() },
    ...(market !== undefined ? { market } : {}),
  };
  return deepFreeze(ctx);
}
