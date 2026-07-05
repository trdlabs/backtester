// Characterization tests for the streaming indicator formulas (020) — coverage flagged sma/adx/
// stochastic at ~1–7% (reached only transitively before). These pin the warmup conventions, window
// math, Wilder smoothing, and the finite (never-NaN) degenerate conventions documented in each
// formula's header. No source change.

import { describe, expect, it } from 'vitest';
import type { Bar } from '@trading/research-contracts/research';
import { createAdx } from '../src/engine/indicators/formulas/adx';
import { createSma } from '../src/engine/indicators/formulas/sma';
import { createStochastic } from '../src/engine/indicators/formulas/stochastic';

// adx/stochastic read only high/low/close; the rest of Bar is filler to satisfy the type.
const bar = (high: number, low: number, close: number): Bar => ({ ts: 0, open: close, high, low, close, volume: 0 });

describe('indicators/sma — createSma', () => {
  it('is undefined until the window fills (warmup = period), then is the window mean', () => {
    const sma = createSma(3);
    sma.update(1);
    expect(sma.value).toBeUndefined();
    sma.update(2);
    expect(sma.value).toBeUndefined();
    sma.update(3);
    expect(sma.value).toBe(2); // (1+2+3)/3
  });

  it('slides the window — the oldest sample is evicted', () => {
    const sma = createSma(3);
    [1, 2, 3, 6].forEach((x) => sma.update(x));
    expect(sma.value).toBeCloseTo((2 + 3 + 6) / 3, 12); // first sample (1) dropped
  });
});

describe('indicators/stochastic — createStochastic', () => {
  it('is undefined until both %K and %D are ready (warmup = k+smooth+d−2)', () => {
    const s = createStochastic(3, 1, 1); // warmup = 3
    s.update(bar(10, 2, 4));
    expect(s.value).toBeUndefined();
    s.update(bar(12, 3, 6));
    expect(s.value).toBeUndefined();
    s.update(bar(11, 1, 9)); // window high=12, window low=1 → %K = 100·(9−1)/(12−1)
    const rawK = 100 * ((9 - 1) / (12 - 1));
    expect(s.value).toEqual({ k: rawK, d: rawK });
  });

  it('smooth>1 averages raw %K (SMA of the last `smooth` raw readings)', () => {
    const s = createStochastic(1, 1, 2); // signature is (k, d, smooth): k=1, d=1, smooth=2 → warmup = 2
    s.update(bar(10, 0, 5));
    expect(s.value).toBeUndefined(); // raw %K=50, not enough raw readings to smooth
    s.update(bar(10, 0, 9)); // raw %K=90 → smoothed %K = mean(50,90)=70; %D=70 (d=1)
    expect(s.value).toEqual({ k: 70, d: 70 });
  });

  it('d>1 makes %D the SMA of the last d smoothed %K (%D is ready last)', () => {
    const s = createStochastic(1, 2, 1); // signature is (k, d, smooth): k=1, d=2, smooth=1 → warmup = 2
    s.update(bar(10, 0, 5));
    expect(s.value).toBeUndefined(); // smoothed %K=50, only one %D sample so far
    s.update(bar(10, 0, 9)); // smoothed %K=90; %D = mean(50,90)=70
    expect(s.value).toEqual({ k: 90, d: 70 });
  });

  it('degenerate flat window (high==low) pins %K at 50 (finite, never NaN)', () => {
    const s = createStochastic(2, 1, 1);
    s.update(bar(5, 5, 5));
    s.update(bar(5, 5, 5)); // window high == window low ⇒ raw %K = 50 by convention
    expect(s.value).toEqual({ k: 50, d: 50 });
  });
});

describe('indicators/adx — createAdx (Wilder smoothing)', () => {
  it('is undefined through warmup, becoming ready at barIndex 2·period−2', () => {
    const adx = createAdx(2); // ready on the 3rd bar (index 2)
    adx.update(bar(10, 8, 9));
    expect(adx.value).toBeUndefined();
    adx.update(bar(12, 10, 11));
    expect(adx.value).toBeUndefined();
    adx.update(bar(14, 12, 13));
    expect(adx.value).toBeDefined();
  });

  it('a pure uptrend (only +DM, no −DM) drives DX and ADX to 100', () => {
    const adx = createAdx(2);
    adx.update(bar(10, 8, 9));
    adx.update(bar(12, 10, 11));
    adx.update(bar(14, 12, 13));
    expect(adx.value).toBeCloseTo(100, 10);
  });

  it('a perfectly flat market (TR=0) pins ADX at 0, not NaN', () => {
    const adx = createAdx(2);
    adx.update(bar(10, 10, 10));
    adx.update(bar(10, 10, 10));
    adx.update(bar(10, 10, 10));
    expect(adx.value).toBe(0);
  });
});
