import { describe, expect, it } from 'vitest';
import { parseTimeframeMs } from '../src/engine/timeframe.js';

describe('parseTimeframeMs', () => {
  it('parses standard <n><unit> timeframes to milliseconds', () => {
    expect(parseTimeframeMs('1m')).toBe(60_000);
    expect(parseTimeframeMs('5m')).toBe(300_000);
    expect(parseTimeframeMs('1h')).toBe(3_600_000);
    expect(parseTimeframeMs('4h')).toBe(14_400_000);
    expect(parseTimeframeMs('1d')).toBe(86_400_000);
    expect(parseTimeframeMs('1w')).toBe(604_800_000);
    expect(parseTimeframeMs('30s')).toBe(30_000);
  });
  it('fail-closed (null) on unknown / malformed / non-positive timeframes', () => {
    expect(parseTimeframeMs('')).toBeNull();
    expect(parseTimeframeMs('bogus')).toBeNull();
    expect(parseTimeframeMs('m')).toBeNull();       // no count
    expect(parseTimeframeMs('0m')).toBeNull();      // non-positive
    expect(parseTimeframeMs('1M')).toBeNull();      // ambiguous month/minute — reject, don't guess
    expect(parseTimeframeMs('1y')).toBeNull();      // unsupported unit
    expect(parseTimeframeMs('1.5h')).toBeNull();    // non-integer
    expect(parseTimeframeMs('1m ')).toBeNull();     // trailing space
    expect(parseTimeframeMs('1h30m')).toBeNull();   // compound
  });
});
