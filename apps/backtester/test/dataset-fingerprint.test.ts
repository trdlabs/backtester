import { describe, expect, it } from 'vitest';
import { tapeFingerprint } from '../src/determinism/dataset-fingerprint.js';
import { contentRef } from '../src/determinism/hash.js';

// D1 / analysis/19 defect #7. The fingerprint is a drift + dedup key, not a contract artifact — these
// pin the three properties that make it safe to swap `contentRef` for `tapeFingerprint`.
describe('tapeFingerprint — dataset drift key without decimal.js', () => {
  const row = (close: number) => ({
    symbol: 'BTCUSDT',
    minute_ts: 1_700_000_000_000,
    open: 100.5,
    high: 101,
    low: 99.25,
    close,
    volume: 12.5,
  });

  it('is deterministic and key-order independent', () => {
    const a = tapeFingerprint([{ b: 2, a: 1 }]);
    const b = tapeFingerprint([{ a: 1, b: 2 }]);
    expect(a).toBe(b);
    expect(a).toBe(tapeFingerprint([{ a: 1, b: 2 }]));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('preserves array order and separates different tapes', () => {
    expect(tapeFingerprint([row(1), row(2)])).not.toBe(tapeFingerprint([row(2), row(1)]));
  });

  it('is STRICTLY FINER than the quantized canonical form (no collision below the 8th place)', () => {
    // canonicalJson quantizes to 8 places, so these two tapes hash identically under contentRef.
    const lo = row(100.000000001);
    const hi = row(100.000000002);
    expect(contentRef([lo])).toBe(contentRef([hi]));
    expect(tapeFingerprint([lo])).not.toBe(tapeFingerprint([hi]));
  });

  it('keeps the non-finite guard — bad market data surfaces, it does not hash', () => {
    expect(() => tapeFingerprint([row(Number.NaN)])).toThrow(/non-finite/);
    expect(() => tapeFingerprint([row(Number.POSITIVE_INFINITY)])).toThrow(/non-finite/);
  });

  it('normalizes -0 and drops undefined fields, as the canonical form does', () => {
    expect(tapeFingerprint([{ v: -0 }])).toBe(tapeFingerprint([{ v: 0 }]));
    expect(tapeFingerprint([{ v: 1, extra: undefined }])).toBe(tapeFingerprint([{ v: 1 }]));
  });
});
