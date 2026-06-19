// Public authoring ABI — hook-facing types for strategy and overlay module authors.
//
// Full context closure: authors receive the complete StrategyContext so authored modules
// typecheck against and stay assignable to the engine's hook interface.
// Type shapes are structurally identical to research-contracts originals; only comments
// have been rewritten in English.

// ── Indicator types (from research-contracts/src/research/indicators.ts) ────────────────

/** Source field over which an indicator is computed (default comes from the catalog). */
export type SourceField = 'close' | 'open' | 'high' | 'low' | 'volume' | 'hlc3' | 'ohlc4';

/** Normalized per-bar indicator request — stable memoization/determinism key. */
export interface IndicatorRequest {
  readonly name: string;
  readonly params?: Readonly<Record<string, number>>;
  readonly source?: SourceField;
}

export interface MacdValue {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}
export interface BollingerValue {
  readonly lower: number;
  readonly middle: number;
  readonly upper: number;
}
export interface StochasticValue {
  readonly k: number;
  readonly d: number;
}

/**
 * Indicator value as-of bar. `undefined` during warmup. No NaN/null/vendor objects
 * are emitted outward.
 */
export type IndicatorValue = number | MacdValue | BollingerValue | StochasticValue;

// ── Point-in-time market API types (from research-contracts/src/research/market-tape.ts) ─

/** OI point as-of minute (read-only). */
export interface OiPoint {
  readonly ts: number;
  readonly oiTotalUsd: number;
}

/** Liquidations point as-of minute (read-only). Covered-no-events → {0,0}. */
export interface LiqPoint {
  readonly ts: number;
  readonly longUsd: number;
  readonly shortUsd: number;
}

/** Funding point as-of minute (read-only). `ts` is the snapshot's own minute_ts, `ts ≤ t`. */
export interface FundingPoint {
  readonly ts: number;
  readonly fundingRate: number;
}

/**
 * Freshness-aware funding reading for the current closed minute `t`. Three-state:
 * `present|stale|missing`. `present`/`stale` carry the actual snapshot; `missing`
 * means no snapshot with `ts ≤ t` exists.
 */
export type FundingReading =
  | { readonly state: 'present'; readonly point: FundingPoint }
  | { readonly state: 'stale'; readonly point: FundingPoint }
  | { readonly state: 'missing' };

/** Raw taker flow point for the minute bucket (read-only). delta = `buyUsd − sellUsd` (derived). */
export interface TakerPoint {
  readonly ts: number;
  readonly buyUsd: number;
  readonly sellUsd: number;
}

/**
 * Taker reading for the minute bucket `[t, t+60s)`. Three-state: `present|stale|missing`.
 * `present` carries raw `{buyUsd,sellUsd}` including present-zero `{0,0}`.
 */
export type TakerReading =
  | { readonly state: 'present'; readonly point: TakerPoint }
  | { readonly state: 'stale' }
  | { readonly state: 'missing' };

/**
 * Point-in-time access to market snapshots. Backwards only — no forward-looking methods
 * (structural no-lookahead invariant). All returned `ts` values are `≤ t`.
 */
export interface PointInTimeMarketApi {
  /** OI exactly at current minute t; undefined if minute is uncovered or OI absent from tape. */
  oiAsOf(): OiPoint | undefined;
  /** Liquidations for minute t; covered-no-events → {longUsd:0,shortUsd:0}; gap → undefined. */
  liqAsOf(): LiqPoint | undefined;
  /**
   * Window of the last `lookback` minute OI buckets ending at t inclusive
   * (index len-1 = minute t). Each slot is a point or undefined (gap, no carry-forward).
   */
  oiWindow(lookback: number): readonly (OiPoint | undefined)[];
  /** Same for liquidations (covered-no-events → {0,0}; gap → undefined). */
  liqWindow(lookback: number): readonly (LiqPoint | undefined)[];
  /**
   * Funding as-of `t` (last snapshot `ts ≤ t`, bounded live-forward). Optional: present
   * only if the tape carries funding. `FundingReading` distinguishes present/stale/missing.
   */
  fundingAsOf?(): FundingReading;
  /**
   * Funding window ending at `t` inclusive. Per-minute as-of live-forward. Optional
   * (composition-following).
   */
  fundingWindow?(lookback: number): readonly (FundingPoint | undefined)[];
  /**
   * Taker as-of `t` (exact minute-t bucket). Optional: present only if the tape carries
   * taker flow. `TakerReading` distinguishes present/stale/missing.
   */
  takerAsOf?(): TakerReading;
  /**
   * Taker window ending at `t` inclusive. Per-minute exact, no carry-forward
   * (gap → undefined, present-zero → real point `{0,0}`). Optional (composition-following).
   */
  takerWindow?(lookback: number): readonly (TakerPoint | undefined)[];
}

// ── Context types (from research-contracts/src/research/context.ts) ─────────────────────

/** Closed (historically complete) candle bar. */
export interface Bar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Snapshot of the current open position. */
export interface PositionSnapshot {
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly stop?: number;
  readonly take?: number;
}

/** Snapshot of a pending (unexecuted) intent. */
export interface IntentSnapshot {
  readonly kind: string;
  readonly side?: 'long' | 'short';
  readonly createdTs: number;
}

/** Snapshot of the portfolio. */
export interface PortfolioSnapshot {
  readonly equity: number;
  readonly openPositions: number;
}

/**
 * Point-in-time access to market data. Backwards only: closed candles up to the
 * current bar and as-of indicators. Absence of forward methods is the structural
 * no-lookahead invariant.
 */
export interface PointInTimeDataApi {
  /** Closed candles strictly BEFORE the current bar (as-of), at most `lookback`. */
  closedCandles(lookback: number): readonly Readonly<Bar>[];
  /** Value of a declared indicator as-of the current bar. */
  indicatorAsOf(name: string): number | undefined;
}

/** Deterministic indicator/helper access (platform SDK). */
export interface IndicatorApi {
  /**
   * Legacy scalar (017/018 back-compat): `value('sma', period)`. Delegates to the engine.
   * Invariant: `value('sma', N) === data.indicatorAsOf('sma_<N>')`.
   */
  value(name: string, ...args: readonly number[]): number | undefined;

  /**
   * 020+ per-bar query by name+params+source. `undefined` during warmup; throws
   * `IndicatorValidationError` for an invalid key (fail-closed).
   */
  query(request: IndicatorRequest): IndicatorValue | undefined;
}

/** Run metadata visible to a hook. */
export interface RunInfo {
  readonly runId: string;
  readonly mode: string;
  readonly seed: number;
}

/**
 * Read-only (deep-frozen) context passed to hooks. `clock`/`rng` are deterministic
 * (simulated clock + seeded RNG), not wall-clock or unmanaged randomness.
 */
export interface StrategyContext {
  readonly run: RunInfo;
  readonly params: Readonly<Record<string, unknown>>;
  readonly symbol: string;
  readonly bar: Readonly<Bar>;
  readonly position: Readonly<PositionSnapshot> | null;
  readonly pendingIntent: Readonly<IntentSnapshot> | null;
  readonly portfolio: Readonly<PortfolioSnapshot>;
  readonly clock: { now(): number };
  readonly data: PointInTimeDataApi;
  readonly indicators: IndicatorApi;
  readonly rng: { next(): number };
  /**
   * Point-in-time market snapshots (OI/liquidations/funding/taker). Present ONLY if the
   * `MarketTape` carries the corresponding kind (composition-following). An OHLCV-only
   * tape → field absent → context shape and 018 outputs unchanged.
   */
  readonly market?: PointInTimeMarketApi;
}

/** Alias emphasising the point-in-time nature of the context. */
export type PointInTimeContext = StrategyContext;

// ── Decision types (from research-contracts/src/research/decision.ts) ──────────────────

/** Enter a position. `side` is required — direction in the decision, not global. */
export interface EnterDecision {
  readonly kind: 'enter';
  readonly side: 'long' | 'short';
  readonly entry?: object;
  readonly stop?: number;
  readonly take?: number;
  readonly ttl?: number;
  readonly sizingHint?: number;
  readonly tags?: readonly string[];
  readonly rationale?: string;
  readonly evidenceRefs?: readonly string[];
}

/** Exit the position. */
export interface ExitDecision {
  readonly kind: 'exit';
  readonly target: string;
  readonly percent?: number;
  readonly reason?: string;
}

/** Add to position / scale-in as intent. */
export interface AddToPositionDecision {
  readonly kind: 'add_to_position';
  readonly mode: 'dca' | 'scale_in';
  readonly sizingHint?: number;
}

/** Update protection hints (stop/take). */
export interface UpdateProtectionDecision {
  readonly kind: 'update_protection';
  readonly stop?: number;
  readonly take?: number;
}

/** Annotation/metadata only (no action). */
export interface AnnotateDecision {
  readonly kind: 'annotate';
  readonly tags?: readonly string[];
  readonly metrics?: object;
  readonly rationale?: string;
}

/** No action. */
export interface IdleDecision {
  readonly kind: 'idle';
}

/** Closed union of strategy decisions. */
export type StrategyDecision =
  | EnterDecision
  | ExitDecision
  | AddToPositionDecision
  | UpdateProtectionDecision
  | AnnotateDecision
  | IdleDecision;

/** Does not change the accumulated decision. */
export interface OverlayPassDecision {
  readonly kind: 'pass';
}

/** Terminal for the current base decision/hook. */
export interface OverlayVetoDecision {
  readonly kind: 'veto';
  readonly reasonCode: string;
  readonly rationale?: string;
}

/** Structural patch over the base strategy decision; after application the decision is schema-valid again. */
export interface OverlayPatchDecision {
  readonly kind: 'patch';
  readonly patch: object;
}

/** Adds metadata only. */
export interface OverlayAnnotateDecision {
  readonly kind: 'annotate';
  readonly tags?: readonly string[];
  readonly notes?: string;
}

/** Closed union of overlay decisions. */
export type OverlayDecision =
  | OverlayPassDecision
  | OverlayVetoDecision
  | OverlayPatchDecision
  | OverlayAnnotateDecision;

// ── Momentum Candle type ─────────────────────────────────────────────────────────────────

/**
 * One minute-aligned canonical market row passed to the `signals(candles, seed)` function.
 * Mirrors `CanonicalRow` / `ReaderRow` from research-contracts exactly — the sandbox harness
 * passes the raw `SymbolSeries.candles` array (ReaderRow[]) unchanged to the untrusted bundle.
 * Note: uses `minute_ts` (not `ts`) and carries optional OI/funding/taker columns, making it
 * structurally distinct from `Bar`.
 */
export interface Candle {
  readonly symbol: string;
  /** Minute-aligned epoch ms (UTC): `minute_ts % 60_000 === 0`. */
  readonly minute_ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
  readonly oi_total_usd: number | null;
  readonly has_oi: boolean;
  readonly funding_rate: number | null;
  readonly has_funding: boolean;
  readonly taker_buy_volume_usd: number | null;
  readonly taker_sell_volume_usd: number | null;
  readonly has_taker_flow: boolean;
}

// ── Top-level ABI shapes ─────────────────────────────────────────────────────────────────

/**
 * Momentum bundle entry point: given an array of canonical candles and a deterministic seed,
 * return a boolean signal array of the same length (true = long, false = flat).
 */
export type MomentumSignals = (
  candles: readonly Candle[],
  seed: number,
) => readonly boolean[];

/** Lifecycle hooks for a strategy module. `onBarClose` is the only required hook. */
export interface LifecycleModule {
  init?(ctx: StrategyContext): void;
  onBarClose(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  onPositionBar?(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  onPendingIntentBar?(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  dispose?(ctx: StrategyContext): void;
}

/** Lifecycle hooks for an overlay module. `apply` is the only required hook. */
export interface OverlayLifecycleModule {
  init?(ctx: StrategyContext): void;
  apply(ctx: StrategyContext): OverlayDecision | readonly OverlayDecision[] | null;
  dispose?(ctx: StrategyContext): void;
}

/** Factory function producing a lifecycle or overlay module instance. */
export type LifecycleModuleFactory<T extends LifecycleModule | OverlayLifecycleModule> = () => T;
