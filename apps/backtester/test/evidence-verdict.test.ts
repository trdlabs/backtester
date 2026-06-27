import { describe, expect, it } from 'vitest';
import { decideVerdict, DEFAULT_THRESHOLDS } from '../src/evidence/verdict.js';

const good = { sharpe: 0.5, max_drawdown: 0.3, win_rate: 0.4, total_trades: 12 };

describe('decideVerdict (conservative defaults)', () => {
  it('passes a clearly-good run', () => {
    expect(decideVerdict(good)).toBe('passed');
  });
  it('fails sharpe <= 0', () => {
    expect(decideVerdict({ ...good, sharpe: 0 })).toBe('failed');
  });
  it('fails drawdown >= 100%', () => {
    expect(decideVerdict({ ...good, max_drawdown: 1 })).toBe('failed');
  });
  it('fails win_rate <= 0', () => {
    expect(decideVerdict({ ...good, win_rate: 0 })).toBe('failed');
  });
  it('fails zero trades', () => {
    expect(decideVerdict({ ...good, total_trades: 0 })).toBe('failed');
  });
  it('fails when a required metric is missing (conservative)', () => {
    expect(decideVerdict({ sharpe: 1, win_rate: 1, total_trades: 5 })).toBe('failed');
  });
  it('default thresholds are the conservative floor', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 });
  });
});
