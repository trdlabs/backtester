// 017 — runner-owned профили риска и исполнения (FR-013/FR-014, data-model §9/§10).
// Не объявляются внутри модуля; привязываются на уровне прогона (FR-016).

/** Границы дистанции (stop/take). */
export interface Bounds {
  readonly min: number;
  readonly max: number;
}

/**
 * RiskProfile — единственный hard-authority слой финального accept/clamp/reject для hints модуля
 * (FR-013). Привязывается к прогону по id+version.
 */
export interface RiskProfile {
  readonly id: string;
  readonly version: string;
  readonly maxConcurrentPositions: number;
  readonly exposureLimits: object;
  readonly allowedSides: readonly ('long' | 'short')[];
  readonly stopBounds?: Bounds;
  readonly takeBounds?: Bounds;
  readonly dcaLimits?: object;
  readonly scaleInLimits?: object;
  readonly validatorRefs?: readonly string[];
}

/**
 * ExecutionProfile — assumptions исполнения (FR-014). Привязывается к прогону по id+version.
 */
export interface ExecutionProfile {
  readonly id: string;
  readonly version: string;
  readonly fillModel: object;
  readonly feeModel: object;
  readonly slippageModel: object;
  /** 035 (realism) — funding cost model. Optional: absent ⇒ no funding accrual (default path unchanged). */
  readonly fundingModel?: object;
  readonly latency?: object;
  readonly partialFill?: object;
  readonly bracketPolicy?: object;
}
