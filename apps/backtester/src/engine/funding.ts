// Ф3 (shared-execution-engine, rollout шаг 4) — the funding ACCRUAL arithmetic is now an IMPORT of
// the shared core; the report-only helper below stays host-side.
//
// `fundingSign` / `perMinuteFundingFraction` / `computeBarFunding` moved to `@trdlabs/engine`
// (`src/core/funding.ts`), ported verbatim from this file. They are execution semantics: the engine
// owns them.
//
// `computeFundingPaidFraction` did NOT move and deliberately stays here: it computes a whole-window
// notional fraction for the realistic-replay GAP *report* (a research output), not the per-bar
// accrual the execution core performs. The engine is the execution core, not the research harness —
// the same boundary that keeps metrics / robustness / comparison host-side.
//
// CONTRACT — input semantics (unchanged): `rate8h` / `rates8h` are 8h-EQUIVALENT funding rates
// as-of each held minute (030 funding column), NOT pre-prorated. SIGN convention: funding_rate > 0
// ⟹ long pays short; a positive result is a cost (cash outflow / paid).

import { Decimal } from 'decimal.js';

import { fundingSign, perMinuteFundingFraction } from '@trdlabs/engine';

export { computeBarFunding, fundingSign, perMinuteFundingFraction } from '@trdlabs/engine';

/** Notional-fraction paid over a held window. Positive = paid; negative = credit. Uncovered minutes skipped. */
export function computeFundingPaidFraction(args: {
  side: 'long' | 'short';
  rates8h: readonly number[];
  covered: readonly boolean[];
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  let acc = new Decimal(0);
  for (let i = 0; i < args.rates8h.length; i += 1) {
    if (!args.covered[i]) continue;
    acc = acc.plus(perMinuteFundingFraction(args.rates8h[i], args.intervalHours).times(args.barMinutes));
  }
  return acc.times(fundingSign(args.side));
}
