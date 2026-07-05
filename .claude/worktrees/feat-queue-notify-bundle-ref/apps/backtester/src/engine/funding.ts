// Realism — pure funding cost calculator (single source of truth for engine accrual AND GAP report).
// No I/O, no profiles import (avoids a cycle). All arithmetic in decimal.js; quantization happens at
// the artifact boundary in the engine, not here.
//
// CONTRACT — input semantics: `rate8h` / `rates8h` are 8h-EQUIVALENT funding rates as-of each held
// minute (030 funding column), NOT pre-prorated. Division by (intervalHours*60) happens EXACTLY here.
// SIGN convention: funding_rate > 0 ⟹ long pays short. sign(long)=+1, sign(short)=−1; a positive
// result is a cost (cash outflow / paid). Some exchanges invert the API sign — normalize upstream.

import { Decimal } from 'decimal.js';

/** +1 for long (pays when rate>0), −1 for short (receives when rate>0). */
export function fundingSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Per-minute fraction of notional implied by an 8h-equivalent rate. Divides by intervalHours*60 once. */
export function perMinuteFundingFraction(rate8h: number, intervalHours: number): Decimal {
  if (!(intervalHours > 0)) throw new Error(`funding: intervalHours must be > 0, got ${intervalHours}`);
  return new Decimal(rate8h).div(intervalHours * 60);
}

/** Cash cost of funding for one bar. Positive = outflow (paid); negative = credit. Uncovered → 0. */
export function computeBarFunding(args: {
  side: 'long' | 'short';
  size: number;
  mark: number;
  rate8h: number;
  covered: boolean;
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  if (!args.covered) return new Decimal(0);
  const notional = new Decimal(args.size).times(args.mark);
  return perMinuteFundingFraction(args.rate8h, args.intervalHours)
    .times(args.barMinutes)
    .times(notional)
    .times(fundingSign(args.side));
}

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
