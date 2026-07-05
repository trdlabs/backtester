import { describe, expect, it } from 'vitest';
import {
  computeBarFunding,
  computeFundingPaidFraction,
  fundingSign,
  perMinuteFundingFraction,
} from '../src/engine/funding';

describe('funding — per-minute proration of the 8h-equivalent rate', () => {
  it('perMinuteFundingFraction divides the 8h rate by intervalHours*60 exactly once', () => {
    // 8h rate 0.0008 over 8h = 480 min → per-minute = 0.0008/480
    expect(perMinuteFundingFraction(0.0008, 8).toNumber()).toBeCloseTo(0.0008 / 480, 15);
  });

  it('fundingSign: long pays (+1), short receives (-1)', () => {
    expect(fundingSign('long')).toBe(1);
    expect(fundingSign('short')).toBe(-1);
  });

  it('computeBarFunding: long + positive rate = cost (cash outflow > 0)', () => {
    // size 2, mark 100, notional 200; 1-min bar; rate 0.0008/8h
    const cost = computeBarFunding({
      side: 'long', size: 2, mark: 100, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8,
    });
    expect(cost.toNumber()).toBeCloseTo((0.0008 / 480) * 200, 15);
    expect(cost.toNumber()).toBeGreaterThan(0);
  });

  it('computeBarFunding: long + NEGATIVE rate = credit (cash inflow < 0)', () => {
    const cost = computeBarFunding({
      side: 'long', size: 2, mark: 100, rate8h: -0.0002, covered: true, barMinutes: 1, intervalHours: 8,
    });
    expect(cost.toNumber()).toBeLessThan(0);
  });

  it('computeBarFunding: short flips the sign vs long', () => {
    const long = computeBarFunding({ side: 'long', size: 1, mark: 50, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8 });
    const short = computeBarFunding({ side: 'short', size: 1, mark: 50, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8 });
    expect(short.toNumber()).toBeCloseTo(-long.toNumber(), 15);
  });

  it('computeBarFunding: uncovered minute charges 0', () => {
    const cost = computeBarFunding({ side: 'long', size: 2, mark: 100, rate8h: 0.0008, covered: false, barMinutes: 1, intervalHours: 8 });
    expect(cost.toNumber()).toBe(0);
  });

  it('computeFundingPaidFraction integrates per-minute and skips uncovered minutes', () => {
    const rates8h = [0.0008, 0.0008, 0.0008];
    const covered = [true, false, true]; // middle minute is a data hole → skipped
    const frac = computeFundingPaidFraction({ side: 'long', rates8h, covered, barMinutes: 1, intervalHours: 8 });
    expect(frac.toNumber()).toBeCloseTo((0.0008 / 480) * 2, 15);
  });

  it('computeFundingPaidFraction: constant rate held a full 8h recovers the discrete 8h charge', () => {
    const rates8h = new Array(480).fill(0.0008);
    const covered = new Array(480).fill(true);
    const frac = computeFundingPaidFraction({ side: 'long', rates8h, covered, barMinutes: 1, intervalHours: 8 });
    expect(frac.toNumber()).toBeCloseTo(0.0008, 12); // self-consistency: integral == 8h rate
  });

  it('intervalHours must be positive (fail-fast)', () => {
    expect(() => perMinuteFundingFraction(0.0008, 0)).toThrow();
  });
});
