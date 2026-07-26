// Ф3 (shared-execution-engine, rollout шаг 4) — the risk engine is now an IMPORT of the shared
// core; this module is the host-side ADAPTER that binds it to a 017 `RiskProfile`.
//
// `RiskEngine` moved to `@trdlabs/engine` (`src/core/risk.ts`) during the Ф2 extraction, carrying
// ONE deliberate semantic change mandated by the SSOT and recorded in the initiative card as a
// prescribed Ф3 divergence:
//
//   SSOT decision 3 (sizing) — the donor sized from a `pct × cash` proxy and returned `sizingPct`.
//   The core owns sizing outright, returns a finished `notional`, and bases `equity_pct` on
//   MARK-TO-MARKET equity rather than cash.
//
// What that costs on this path, precisely: 017 `RiskProfile` has no `sizing` slot, so the adapter
// derives one from the profile's existing authority — `exposureLimits.maxPositionNotionalPct` — as
// `equity_pct`. That reproduces the donor's number wherever the two bases agree, and they agree on
// every `enter`: an entry is decided while FLAT, and a flat portfolio's MTM equity IS its cash
// (`equity = cash + unrealized`, `unrealized = 0`). The bases diverge only where a position is
// already open — i.e. `add_to_position` (DCA / scale-in), whose notional and cumulative-ceiling
// base move from cash to MTM equity. That is the whole blast radius of decision 3 here, and it is
// the reason the default single-entry goldens do not move.

import type { RiskProfile } from '@trading/research-contracts/research';

import {
  RiskEngine as CoreRiskEngine,
  type AddLimits,
  type Bounds,
  type ExposureLimits,
  type RiskProfile as CoreRiskProfile,
} from '@trdlabs/engine';

export type { RiskContext, RiskOutcome } from '@trdlabs/engine';

/**
 * Lift a 017 `RiskProfile` into the core's profile shape. 017 types `exposureLimits` / `dcaLimits` /
 * `scaleInLimits` as bare `object` (the concrete forms are runner-owned — `profiles.ts`), so the
 * slots are narrowed here rather than in the contract.
 */
export function coreRiskProfile(profile: RiskProfile): CoreRiskProfile {
  const exposure = profile.exposureLimits as ExposureLimits;
  const dca = (profile as { readonly dcaLimits?: unknown }).dcaLimits as AddLimits | undefined;
  const scaleIn = (profile as { readonly scaleInLimits?: unknown }).scaleInLimits as
    | AddLimits
    | undefined;
  return {
    id: profile.id,
    version: profile.version,
    maxConcurrentPositions: profile.maxConcurrentPositions,
    exposureLimits: exposure,
    allowedSides: profile.allowedSides,
    // Decision 3: the profile's exposure ceiling doubles as its sizing authority on this path.
    sizing: { kind: 'equity_pct', pct: exposure.maxPositionNotionalPct },
    ...(profile.stopBounds !== undefined ? { stopBounds: profile.stopBounds as Bounds } : {}),
    ...(profile.takeBounds !== undefined ? { takeBounds: profile.takeBounds as Bounds } : {}),
    ...(dca !== undefined ? { dcaLimits: dca } : {}),
    ...(scaleIn !== undefined ? { scaleInLimits: scaleIn } : {}),
  };
}

/** Host binding of the core risk engine to a 017 `RiskProfile`. */
export class RiskEngine extends CoreRiskEngine {
  constructor(profile: RiskProfile) {
    super(coreRiskProfile(profile));
  }
}
