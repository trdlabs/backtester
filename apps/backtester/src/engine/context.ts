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

import type { MarketTapeDataset, PointInTimeMarketApi } from '@trading/research-contracts/research';

import { createIndicatorEngine } from './indicators/index.js';
import type { IndicatorEngine } from './indicators/index.js';

import { indicatorApiFor, pointInTimeDataApi } from './dataset.js';
import { pointInTimeMarketApi, thinPointInTimeMarketApi, THIN_SURFACE_ENABLED } from './market-access.js';
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

/** Опции построителя. */
export interface ContextBuilderOptions {
  /**
   * Морозить ли контекст на каждом баре.
   *
   * `true` (по умолчанию) — прежнее поведение: рекурсивная заморозка каждого построенного
   * контекста. Она ловит мутацию контекста модулем громко и сразу, и именно поэтому остаётся
   * дефолтом в dev и CI.
   *
   * `false` — заморозка пропускается. Гарантия read-only при этом не исчезает, а меняет
   * природу: в проде контекст видит только доверенный раннер и код в изоляте, который получает
   * не сам объект, а маршалированный снимок. Диагностика мутаций нужна там, где стратегию
   * пишут, а не там, где её гоняют миллион баров подряд.
   */
  readonly freeze?: boolean;
  /**
   * T1-спайк (2026-08-05, PROFILE_THIN_SURFACE) — по какому исполнителю строится рыночная
   * поверхность `ctx.market`.
   *
   * `'trusted'` (по умолчанию) — прежнее поведение ВСЕГДА, независимо от `PROFILE_THIN_SURFACE`:
   * полная `pointInTimeMarketApi`. Ни один существующий вызывающий код (runner.ts, тесты,
   * `scripts/profile-context.mts`) это поле не передаёт → нулевой блэст-радиус для них.
   *
   * `'sandbox'` — при `PROFILE_THIN_SURFACE=true` строится худая 4-члена поверхность (T1, см.
   * `market-access.ts::thinPointInTimeMarketApi`); без флага не отличается от `'trusted'`. Выбор
   * ОБЯЗАН отражать реального исполнителя контекста: пометить `'sandbox'` для контекста, который
   * попадёт в доверенный путь (`ctx.market.oiWindow(...)` там есть в контракте) — ошибка
   * вызывающего кода, а не гонка этого спайка. Худая поверхность не реализует
   * `PointInTimeMarketApi` целиком, поэтому такое рассогласование падает TypeError'ом на первом
   * же обращении к отсутствующему методу — явно, а не тихим неверным числом.
   */
  readonly executorKind?: 'trusted' | 'sandbox';
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

  /** P3-1: минутная сетка ленты (ts по индексу) — материализуется ОДИН раз на символ, а не на каждый
   *  бар, и передаётся в pointInTimeMarketApi вместе с индексом (убирает O(n) аллокацию + O(n) indexOf
   *  на бар). undefined, когда лента не несёт market-kind. */
  private readonly marketGridTs?: readonly number[];

  /** См. `ContextBuilderOptions.freeze`. Читается один раз: менять режим по ходу прогона нельзя. */
  private readonly freezePerBar: boolean;

  /** См. `ContextBuilderOptions.executorKind`. Читается один раз: у построителя один исполнитель. */
  private readonly executorKind: 'trusted' | 'sandbox';

  constructor(
    private readonly base: ContextBuilderBase,
    options: ContextBuilderOptions = {},
  ) {
    this.freezePerBar = options.freeze ?? true;
    this.executorKind = options.executorKind ?? 'trusted';
    // Заморозка ОДИН РАЗ на символ — и она безусловна, в отличие от пербарной.
    //
    // Всё остальное, до чего дотягивается контекст, защищено само собой: свечи заморожены у
    // источника (`loadCandleDataset`, `marketTapeFromCanonicalRows`), а `position`/`portfolio`/
    // `data`/`indicators`/`clock`/`market` строятся заново на каждый бар из примитивов — испортив
    // их, стратегия испортит только свой собственный бар.
    //
    // `run` и `params` — единственное исключение: они ОБЩИЕ для всех баров символа. Без этой
    // строки выключенная пербарная заморозка открыла бы стратегии возможность переписать params
    // и тем изменить все последующие бары. Здесь это и закрывается — раз на символ, а не 60 тысяч раз.
    deepFreeze(base.run);
    deepFreeze(base.params);
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
    this.marketGridTs = this.carriesMarket && tape !== undefined ? tape.candles(base.symbol).map((b) => b.ts) : undefined;
  }

  /**
   * T1-спайк (PROFILE_THIN_SURFACE, docs/superpowers/sdd/2026-08-05-t1-thin-surface-measurement).
   * По умолчанию (флаг выключен ИЛИ `executorKind !== 'sandbox'`) — байт-в-байт прежнее поведение:
   * полная `pointInTimeMarketApi`. Только когда ОБА условия выполнены — построитель явно помечен
   * `executorKind: 'sandbox'` И включён `PROFILE_THIN_SURFACE=true` — строится худая 4-члена
   * поверхность. Условие двойное НАМЕРЕННО: один лишь флаг окружения ничего не переключает —
   * построитель для доверенного пути никогда не помечается `'sandbox'` вызывающим кодом, поэтому
   * активация не может протечь на доверенный путь через одну переменную окружения.
   */
  private buildMarketSurface(marketTape: MarketTapeDataset, t: number, barIndex: number): PointInTimeMarketApi {
    // Fast path: barIndex IS the tape-grid index when base.candles aligns with the tape grid (the
    // norm — same materialized per-symbol stream). Fall back to indexOf only on a misaligned/absent
    // slot, so the resolved idx is byte-identical to the old self-computed one.
    const idx = this.marketGridTs![barIndex] === t ? barIndex : this.marketGridTs!.indexOf(t);
    const precomputed = { gridTs: this.marketGridTs!, idx };
    if (THIN_SURFACE_ENABLED && this.executorKind === 'sandbox') {
      // Худая поверхность не реализует PointInTimeMarketApi целиком (нет oiWindow/liqWindow/
      // funding*/taker*) — публичный контракт (SDK) не трогаем; на этом пути её читают только
      // песочничные потребители, которым нужны ровно эти четыре члена (см. market-access.ts).
      return thinPointInTimeMarketApi(marketTape, this.base.symbol, t, precomputed) as unknown as PointInTimeMarketApi;
    }
    return pointInTimeMarketApi(marketTape, this.base.symbol, t, precomputed);
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
        ? { market: this.buildMarketSurface(this.base.marketTape, bar.ts, barIndex) }
        : {}),
    };
    return this.freezePerBar ? deepFreeze(ctx) : ctx;
  }
}
