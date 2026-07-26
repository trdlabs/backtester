// Ф3 (shared-execution-engine, rollout шаг 4) — the execution simulator is now an IMPORT of the
// shared core; this module is the host-side ADAPTER that binds it to a 017 `ExecutionProfile`.
//
// `ExecutionSimulator` moved to `@trdlabs/engine` (`src/core/execution.ts`) during the Ф2
// extraction. The core is driven by a versioned `RealityModel` (SSOT decision 9) instead of an
// `ExecutionProfile` with embedded model slots, so the host translates one into the other here.
// This is exactly the dual-read window the 017 contract change describes: the backtester still
// binds `executionProfileRef`, and the embedded model slots are lifted into a `RealityModel` whose
// identity is the profile's own `id@version`.
//
// Two consequences worth naming, because both are load-bearing:
//
//   • `computeOpenFill(side, base, notional)` no longer takes `(sizingPct, cash)`. Risk owns sizing
//     outright (SSOT decision 3) and hands execution a finished notional; the simulator must not
//     re-derive it. See `risk.ts` for the sizing half of the same decision.
//   • Catalog validation moved into the core (`assertRealityModelSupported`, fail-fast, no silent
//     fallback). The reject message keeps the shape the pre-flight gate and its fixtures assert:
//     `unsupported <slot>.kind: <kind>`.

import type { ExecutionProfile } from '@trading/research-contracts/research';

import {
  ExecutionSimulator as CoreExecutionSimulator,
  type FeeModel,
  type FillModel,
  type FundingModel,
  type RealityModel,
  type SlippageModel,
} from '@trdlabs/engine';

export type { CloseFillCalc, OpenFillCalc } from '@trdlabs/engine';

/**
 * Lift a 017 `ExecutionProfile`'s embedded model slots into a versioned `RealityModel` (017
 * dual-read window). Identity is the profile's own `id@version` — the profile IS the environment
 * declaration on this path, so inventing a second identity would create a source of truth with no
 * conflict rule (the initiative's recorded shape decision).
 *
 * `latency`/`partialFill` are declared explicitly rather than omitted: the backtester executes
 * without latency and never partially fills, and an EXPLICIT declaration is what distinguishes a
 * stated environment from an assumed one. Unknown kinds in any slot are rejected by the core.
 */
export function realityModelFromExecutionProfile(profile: ExecutionProfile): RealityModel {
  const funding = (profile as { readonly fundingModel?: unknown }).fundingModel;
  return {
    id: profile.id,
    version: profile.version,
    fillModel: profile.fillModel as FillModel,
    feeModel: profile.feeModel as FeeModel,
    slippageModel: profile.slippageModel as SlippageModel,
    ...(funding !== undefined ? { fundingModel: funding as FundingModel } : {}),
    latency: { kind: 'zero' },
    partialFill: { kind: 'none' },
  };
}

/** Host binding of the core simulator to a 017 `ExecutionProfile`. */
export class ExecutionSimulator extends CoreExecutionSimulator {
  constructor(profile: ExecutionProfile) {
    super(realityModelFromExecutionProfile(profile));
  }
}
