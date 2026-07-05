// Deterministic seeded PRNG — the only source of run "randomness".
//
// Ported verbatim from trading-platform `src/research/backtest/rng.ts` (018). Seed = `request.seed`.
// No `Math.random` — byte-identical replay requires fully controlled randomness (SC-008).

/** Minimal seeded RNG shape; compatible with 017 `StrategyContext.rng` (`{ next(): number }`). */
export interface SeededRng {
  /** Next pseudo-random number in [0, 1). */
  next(): number;
}

/**
 * `mulberry32` — a compact deterministic 32-bit PRNG. The same `seed` yields the same sequence for
 * the same order of `next()` calls.
 */
export function createSeededRng(seed: number): SeededRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
