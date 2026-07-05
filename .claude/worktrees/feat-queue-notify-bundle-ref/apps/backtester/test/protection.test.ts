// Characterization tests for the runner-owned protection detector (024/US3) — coverage flagged
// protection.ts at ~6%. These pin protectionLevels + detectProtection (pure, stateless): fractional
// stop/take distances → quantized levels, stop-first ordering (FR-020), and the gap-through fillBase
// rule (R2). No source change.

import { describe, expect, it } from 'vitest';
import { detectProtection, protectionLevels } from '../src/engine/protection';

describe('engine/protection — protectionLevels', () => {
  it('long: stop sits below entry (E·(1−stop)), take above (E·(1+take))', () => {
    expect(protectionLevels('long', 100, 0.05, 0.1)).toEqual({ stopLevel: 95, takeLevel: 110 });
  });

  it('short mirrors long: stop above (E·(1+stop)), take below (E·(1−take))', () => {
    expect(protectionLevels('short', 100, 0.05, 0.1)).toEqual({ stopLevel: 105, takeLevel: 90 });
  });

  it('omits the level whose fractional distance is undefined', () => {
    expect(protectionLevels('long', 100, 0.05, undefined)).toEqual({ stopLevel: 95 });
    expect(protectionLevels('long', 100, undefined, 0.1)).toEqual({ takeLevel: 110 });
    expect(protectionLevels('long', 100, undefined, undefined)).toEqual({});
  });
});

describe('engine/protection — detectProtection', () => {
  it('returns null when neither stop nor take is set', () => {
    expect(detectProtection('long', 100, undefined, undefined, { open: 100, high: 200, low: 1 })).toBeNull();
  });

  it('long stop_hit fills exactly at the level when the bar did not gap through it', () => {
    // stopLevel=95; low 94 ≤ 95 triggers; open 98 > 95 ⇒ fill at the level
    expect(detectProtection('long', 100, 0.05, undefined, { open: 98, high: 99, low: 94 })).toEqual({
      kind: 'stop_hit',
      fillBase: 95,
    });
  });

  it('long stop gap-through fills at the open (market opened past the level, R2)', () => {
    // open 93 ≤ stopLevel 95 ⇒ gap ⇒ fillBase = open
    expect(detectProtection('long', 100, 0.05, undefined, { open: 93, high: 96, low: 90 })).toEqual({
      kind: 'stop_hit',
      fillBase: 93,
    });
  });

  it('long take_hit at the level when no stop triggers', () => {
    // takeLevel=110; high 111 ≥ 110 triggers; open 108 < 110 ⇒ fill at the level
    expect(detectProtection('long', 100, 0.05, 0.1, { open: 108, high: 111, low: 107 })).toEqual({
      kind: 'take_hit',
      fillBase: 110,
    });
  });

  it('stop-first: when both levels are reachable in [low, high], stop wins (FR-020)', () => {
    // stopLevel=95 (low 94 ≤ 95) AND takeLevel=110 (high 111 ≥ 110) — stop is checked first
    expect(detectProtection('long', 100, 0.05, 0.1, { open: 100, high: 111, low: 94 })).toEqual({
      kind: 'stop_hit',
      fillBase: 95,
    });
  });

  it('short stop_hit triggers when high crosses the above-entry stop level', () => {
    // short stopLevel=105; high 106 ≥ 105 triggers; open 102 < 105 ⇒ fill at the level
    expect(detectProtection('short', 100, 0.05, undefined, { open: 102, high: 106, low: 101 })).toEqual({
      kind: 'stop_hit',
      fillBase: 105,
    });
  });

  it('returns null when the bar stays strictly inside both levels', () => {
    // stopLevel=95, takeLevel=110; bar fully within (96..109)
    expect(detectProtection('long', 100, 0.05, 0.1, { open: 100, high: 109, low: 96 })).toBeNull();
  });
});
