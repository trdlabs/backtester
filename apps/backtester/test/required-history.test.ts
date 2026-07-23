// wfo-extended-fixture item 4 (backtester part) — pure required-history sizing + the up-front
// sufficiency check shared by the three advisory resolvers (WFO/novelty/holdout in worker.ts). No I/O
// besides the best-effort tier-catalog read inside `checkSufficientHistory` (never throws past it).

import { describe, expect, it } from 'vitest';
import {
  checkSufficientHistory,
  requiredHoldoutDays,
  requiredNoveltyDays,
  requiredWalkForwardDays,
} from '../src/engine/required-history.js';

describe('requiredWalkForwardDays', () => {
  it('(maxFolds+1)*MACD-warmup(34) bars at the 1h cadence ⇒ ~30 days (default maxFolds=20)', () => {
    // (20+1)*34 = 714 bars * 60 min = 42_840 min / 1440 = 29.75d ⇒ ceil 30.
    expect(requiredWalkForwardDays('1h', 20)).toBe(30);
  });

  it('a finer timeframe needs proportionally less wall-clock history', () => {
    // (20+1)*34 = 714 bars * 1 min = 714 min / 1440 = 0.495d ⇒ ceil 1.
    expect(requiredWalkForwardDays('1m', 20)).toBe(1);
  });

  it('fewer folds ⇒ fewer required days', () => {
    expect(requiredWalkForwardDays('1h', 2)).toBeLessThan(requiredWalkForwardDays('1h', 20)!);
  });

  it('unparseable timeframe ⇒ null (fail-open — skip the up-front check)', () => {
    expect(requiredWalkForwardDays('bogus', 20)).toBeNull();
  });
});

describe('requiredNoveltyDays', () => {
  it('is exactly the configured minOverlapDays', () => {
    expect(requiredNoveltyDays(30)).toBe(30);
    expect(requiredNoveltyDays(7)).toBe(7);
  });
});

describe('requiredHoldoutDays', () => {
  it('reads minWfoHistoryDays from the committed catalog (30)', () => {
    expect(requiredHoldoutDays()).toBe(30);
  });
});

describe('checkSufficientHistory', () => {
  const DAY = 86_400_000;
  function period(days: number) {
    return { from: new Date(0).toISOString(), to: new Date(days * DAY).toISOString() };
  }

  it('42-day span vs a 30-day requirement ⇒ sufficient (undefined)', () => {
    expect(checkSufficientHistory(period(42), 30)).toBeUndefined();
  });

  it('exactly the required span ⇒ sufficient (>=, not >)', () => {
    expect(checkSufficientHistory(period(30), 30)).toBeUndefined();
  });

  it('7-day span vs a 30-day requirement ⇒ insufficient, names T2', () => {
    const hit = checkSufficientHistory(period(7), 30);
    expect(hit).toBeDefined();
    expect(hit?.requiredDays).toBe(30);
    expect(hit?.requiredTier).toContain('T2');
  });

  it('malformed period (from >= to) ⇒ undefined (not this function’s concern — deep validation owns it)', () => {
    expect(checkSufficientHistory({ from: 'z', to: 'a' }, 30)).toBeUndefined();
    expect(checkSufficientHistory({ from: new Date(DAY).toISOString(), to: new Date(0).toISOString() }, 30)).toBeUndefined();
  });
});
