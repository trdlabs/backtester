// Public authoring ABI — hook-facing types for strategy and overlay module authors.
//
// 042 FU1: the 017 contract types are re-sourced from the platform kernel
// (@trdlabs/sdk/research-contract) — single source of truth, no drift.
// Authoring-specific shapes (Candle/MomentumSignals/LifecycleModule/...) stay local; they
// compose the kernel types below.

// ── 017 contract types — re-exported from the kernel (single source) ──────────────────────
export type {
  // indicators
  SourceField,
  IndicatorRequest,
  MacdValue,
  BollingerValue,
  StochasticValue,
  IndicatorValue,
  // market-tape point-in-time
  OiPoint,
  LiqPoint,
  FundingPoint,
  FundingReading,
  TakerPoint,
  TakerReading,
  PointInTimeMarketApi,
  // context
  Bar,
  PositionSnapshot,
  IntentSnapshot,
  PortfolioSnapshot,
  PointInTimeDataApi,
  IndicatorApi,
  RunInfo,
  StrategyContext,
  PointInTimeContext,
  // decisions
  EnterDecision,
  ExitDecision,
  AddToPositionDecision,
  UpdateProtectionDecision,
  AnnotateDecision,
  IdleDecision,
  StrategyDecision,
  OverlayPassDecision,
  OverlayVetoDecision,
  OverlayPatchDecision,
  OverlayAnnotateDecision,
  OverlayDecision,
} from '@trdlabs/sdk/research-contract';

// Local bindings of the kernel types used by the authoring-specific shapes below.
import type {
  StrategyContext,
  StrategyDecision,
  OverlayDecision,
} from '@trdlabs/sdk/research-contract';

// ── Authoring-specific shapes (backtester SDK public ABI) ─────────────────────────────────

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
