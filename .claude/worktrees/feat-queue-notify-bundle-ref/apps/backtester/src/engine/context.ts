// 018 — построитель point-in-time deep-frozen `StrategyContext` (data-model §5, research R6,
// FR-011/012, SC-004). Контекст на бар `t`: `bar` = закрытая свеча `t`; `data.closedCandles` —
// строго до `t`; `clock.now()` = `bar.ts` (sim-clock, не wall-clock); `rng` — единый seeded
// источник прогона. Рекурсивная заморозка делает контекст read-only (мутация модулем → throw).

import type {
  Bar,
  IntentSnapshot,
  PortfolioSnapshot,
  PositionSnapshot,
  RunInfo,
  StrategyContext,
} from '@trading/research-contracts/research';

import type { MarketTapeDataset } from '@trading/research-contracts/research';

import { createIndicatorEngine } from './indicators/index.js';
import type { IndicatorEngine } from './indicators/index.js';

import { indicatorApiFor, pointInTimeDataApi } from './dataset.js';
import { pointInTimeMarketApi } from './market-access.js';
import type { SeededRng } from '../determinism/rng.js';

/** Рекурсивно заморозить объект/функцию и все достижимые по свойствам значения (идемпотентно). */
function deepFreeze<T>(obj: T): T {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
  Object.freeze(obj);
  for (const propKey of Object.getOwnPropertyNames(obj)) {
    const value = (obj as Record<string, unknown>)[propKey];
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return obj;
}

/** Неизменная на протяжении прогона/символа основа контекста. */
export interface ContextBuilderBase {
  readonly run: RunInfo;
  readonly params: Readonly<Record<string, unknown>>;
  readonly symbol: string;
  readonly candles: readonly Readonly<Bar>[];
  /** Единый seeded RNG прогона (общий источник; продвигается на каждом `next()`). */
  readonly rng: SeededRng;
  /**
   * 023 (additive) — материализованная рыночная лента символа. Если она несёт OI/liquidations,
   * `build()` выставляет `ctx.market` (composition-following, FR-008). OHLCV-only / отсутствие ленты
   * → ключа `market` нет → форма контекста 018 неизменна.
   */
  readonly marketTape?: MarketTapeDataset;
}

/** Изменяемое от бара к бару состояние портфеля/позиции/intent'а. */
export interface PerBarState {
  readonly position: Readonly<PositionSnapshot> | null;
  readonly pendingIntent: Readonly<IntentSnapshot> | null;
  readonly portfolio: Readonly<PortfolioSnapshot>;
}

/** Строит deep-frozen `StrategyContext` на конкретный бар `t` из основы + per-bar состояния. */
export class PointInTimeContextBuilder {
  /** Один per-run (per-symbol) движок индикаторов; стримит закрытые свечи прогона (R4). */
  private readonly indicatorEngine: IndicatorEngine;

  /** Несёт ли лента OI/liquidations/funding/taker для символа (composition-following; вычисляется один раз). */
  private readonly carriesMarket: boolean;

  constructor(private readonly base: ContextBuilderBase) {
    this.indicatorEngine = createIndicatorEngine(base.candles);
    const tape = base.marketTape;
    // 030: funding/taker добавлены в OR-цепочку. ctx.market выставляется, если лента несёт ЛЮБОЙ kind;
    // конкретные методы (fundingAsOf?/takerAsOf?) навешиваются в market-access по составу ленты.
    this.carriesMarket =
      tape !== undefined &&
      (tape.openInterest(base.symbol) !== undefined ||
        tape.liquidations(base.symbol) !== undefined ||
        tape.funding(base.symbol) !== undefined ||
        tape.taker(base.symbol) !== undefined);
  }

  build(barIndex: number, state: PerBarState): StrategyContext {
    const bar = this.base.candles[barIndex];
    if (bar === undefined) {
      throw new Error(`PointInTimeContextBuilder: bar index ${barIndex} out of range`);
    }
    const ctx: StrategyContext = {
      run: this.base.run,
      params: this.base.params,
      symbol: this.base.symbol,
      bar,
      position: state.position,
      pendingIntent: state.pendingIntent,
      portfolio: state.portfolio,
      clock: { now: () => bar.ts },
      data: pointInTimeDataApi(this.base.candles, barIndex),
      indicators: indicatorApiFor(this.indicatorEngine, barIndex),
      rng: { next: () => this.base.rng.next() },
      // 023: market выставляется ТОЛЬКО когда лента несёт kind (иначе ключ отсутствует — форма 018).
      ...(this.carriesMarket && this.base.marketTape !== undefined
        ? { market: pointInTimeMarketApi(this.base.marketTape, this.base.symbol, bar.ts) }
        : {}),
    };
    return deepFreeze(ctx);
  }
}
