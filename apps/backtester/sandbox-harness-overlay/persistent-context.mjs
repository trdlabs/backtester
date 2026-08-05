// СПАЙК S0 (`PROFILE_SNAPSHOT_FREE=true`) — ПЕРСИСТЕНТНАЯ ПОВЕРХНОСТЬ КОНТЕКСТА. НЕ МЕРЖИТСЯ.
//
// Отвечает на один вопрос: сколько стоит пербарный снимок контекста ЦЕЛИКОМ — вместе с нерыночной
// частью, — если снять его механизм, а не только рыночные поля.
//
// Легаси-путь (`rehydrate.mjs`) на КАЖДОМ событии собирает объект `ctx` из восьми полей, строит
// `data` с двумя замыканиями, `clock`, `rng`, четырёхметодную рыночную поверхность и рекурсивно
// морозит всё это (`deepFreeze`). Замерено на зеркале: 5.8 мкс на событие только на регидрацию с
// заморозкой, плюс 4.4 мкс на разбор входного JSON, который эту сборку кормит.
//
// Здесь `ctx` строится ОДИН раз на символ — замороженный фасад с геттерами над изменяемыми
// внутренностями слота. На событии обновляются внутренности (`onNewBar`/`setClock`/`setPosition`/…),
// сам объект не пересобирается и `deepFreeze` не зовётся. Read-only-инвариант 017 сохранён иначе:
// фасад заморожен один раз, а всё, что меняется, приезжает уже замороженным.
//
// Буферы свечей/oi/liq и движок индикаторов (`engineByBuffer` WeakMap по идентичности буфера) уже
// персистентны — они переиспользуются как есть.

import { deepFreeze, freezeBarsUpTo, indicatorEngineFor } from './rehydrate.mjs';

/** `[side, size, entryPrice, stop|null, take|null]` → замороженный PositionSnapshot. */
function positionOf(a) {
  const out = { side: a[0], size: a[1], entryPrice: a[2] };
  if (a[3] !== null) out.stop = a[3];
  if (a[4] !== null) out.take = a[4];
  return Object.freeze(out);
}

/** `[kind, side|null, createdTs]` → замороженный IntentSnapshot. */
function intentOf(a) {
  const out = { kind: a[0] };
  if (a[1] !== null) out.side = a[1];
  out.createdTs = a[2];
  return Object.freeze(out);
}

/**
 * Создать персистентную поверхность для слота символа.
 *
 * `init` — инварианты, приехавшие ОДИН раз при `initSymbol`: `{run, params, symbol}`.
 * `slot` — слот из `makeInstanceStore` (`buffer`/`oiBuffer`/`liqBuffer`/`rng` уже живут в нём).
 */
export function createPersistentContext(init, slot) {
  const buffer = slot.buffer;
  const oiBuffer = slot.oiBuffer;
  const liqBuffer = slot.liqBuffer;
  const rng = slot.rng;

  // Единственное изменяемое состояние поверхности. Стратегия его не видит: наружу торчат только
  // геттеры замороженного фасада.
  const state = {
    t: -1,
    bar: null,
    clockNow: 0,
    position: null,
    pendingIntent: null,
    portfolio: null,
    accessor: undefined,
    lastLookback: -1,
    lastSlice: undefined,
  };

  const engine = indicatorEngineFor(buffer);

  // ── неизменное: строится один раз ────────────────────────────────────────────────────────────
  const run = Object.freeze({ runId: init.run.runId, mode: init.run.mode, seed: init.run.seed });
  const params = deepFreeze(init.params ?? {});
  const symbol = init.symbol;

  // `data` — тот же контракт, что в `rehydrateContext`: `closedCandles(lookback)` строго ДО t,
  // мемо на (бар, lookback) — сбрасывается в `onNewBar`, а не пересоздаётся вместе с объектом.
  const data = Object.freeze({
    closedCandles(lookback) {
      if (lookback === state.lastLookback) return state.lastSlice;
      freezeBarsUpTo(buffer, state.t);
      state.lastSlice = Object.freeze(buffer.slice(Math.max(0, state.t - lookback), state.t));
      state.lastLookback = lookback;
      return state.lastSlice;
    },
    indicatorAsOf(name) {
      const m = /^sma_(\d+)$/.exec(name);
      if (m !== null) return state.accessor.value('sma', Number(m[1]));
      return undefined;
    },
  });

  const oiPoint = (s) => (s === null || s === undefined ? undefined : Object.freeze({ ts: s.ts, oiTotalUsd: s.oiTotalUsd }));
  const liqPoint = (s) => (s === null || s === undefined ? undefined : Object.freeze({ ts: s.ts, longUsd: s.longUsd, shortUsd: s.shortUsd }));
  const windowOf = (buf, lookback, toPoint) => {
    if (buf.length === 0 || !Number.isInteger(lookback) || lookback <= 0) return Object.freeze([]);
    const start = Math.max(0, state.t - lookback + 1);
    return Object.freeze(buf.slice(start, state.t + 1).map(toPoint));
  };
  // 023-семантика без изменений; отличие только в том, что объект и его замыкания живут всю сессию,
  // а `t` читается из `state` в момент вызова, а не захватывается на событии.
  const market = Object.freeze({
    oiAsOf: () => (oiBuffer.length > 0 ? oiPoint(oiBuffer[state.t]) : undefined),
    liqAsOf: () => (liqBuffer.length > 0 ? liqPoint(liqBuffer[state.t]) : undefined),
    oiWindow: (lookback) => (oiBuffer.length > 0 ? windowOf(oiBuffer, lookback, oiPoint) : Object.freeze([])),
    liqWindow: (lookback) => (liqBuffer.length > 0 ? windowOf(liqBuffer, lookback, liqPoint) : Object.freeze([])),
  });

  const clock = Object.freeze({ now: () => state.clockNow });
  const rngFacade = Object.freeze({ next: () => rng.next() });

  // Изменяемые поля — АКСЕССОРЫ: замороженный объект не допускает записи в data-свойство, а геттер
  // после `Object.freeze` продолжает работать. Так фасад остаётся read-only для стратегии и при этом
  // не пересобирается.
  const ctx = {};
  Object.defineProperties(ctx, {
    run: { value: run, enumerable: true },
    params: { value: params, enumerable: true },
    symbol: { value: symbol, enumerable: true },
    bar: { get: () => state.bar, enumerable: true },
    position: { get: () => state.position, enumerable: true },
    pendingIntent: { get: () => state.pendingIntent, enumerable: true },
    portfolio: { get: () => state.portfolio, enumerable: true },
    clock: { value: clock, enumerable: true },
    data: { value: data, enumerable: true },
    indicators: { get: () => state.accessor, enumerable: true },
    rng: { value: rngFacade, enumerable: true },
    // Состав ленты известен только с первого события; легаси опускал ключ, здесь геттер отдаёт
    // `undefined` до первого oi/liq — для `ctx.market?.…` и `if (ctx.market)` это одно и то же.
    market: { get: () => (oiBuffer.length > 0 || liqBuffer.length > 0 ? market : undefined), enumerable: true },
  });
  Object.freeze(ctx);

  return {
    ctx,
    /** Новый закрытый бар уже в буфере: сдвинуть t, аксессор индикаторов и сбросить мемо окна. */
    onNewBar(bar) {
      state.t = buffer.length - 1;
      state.bar = bar;
      // Аксессор привязан к бару по построению (`accessorAt(t)`), поэтому обновляется раз в бар, а
      // не раз в событие. Заморозка — чтобы `ctx.indicators` оставался read-only, как после deepFreeze.
      state.accessor = Object.freeze(engine.accessorAt(state.t));
      state.lastLookback = -1;
      state.lastSlice = undefined;
    },
    setClock(now) {
      state.clockNow = now;
    },
    setPosition(a) {
      state.position = a === null ? null : positionOf(a);
    },
    setPendingIntent(a) {
      state.pendingIntent = a === null ? null : intentOf(a);
    },
    setPortfolio(a) {
      state.portfolio = Object.freeze({ equity: a[0], openPositions: a[1] });
    },
  };
}
