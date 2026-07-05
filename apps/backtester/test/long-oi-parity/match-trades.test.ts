import { describe, it, expect } from 'vitest';
import { scorableGolden, matchTrades } from './match-trades.js';
import type { SignalParityGoldenTrade } from './golden-types.js';
import type { GeneratedTrade } from './run-long-oi.js';

const WARMUP = 60 * 60_000;
const g = (o: Partial<SignalParityGoldenTrade> = {}): SignalParityGoldenTrade => ({ tradeId: 'g1', symbol: 'ESPORTSUSDT', side: 'long', openedAtMs: 10_000_000, closedAtMs: 10_060_000, pnlPct: '5.0', closeReason: 'take_profit_final', closeReasonRaw: 'tp2', entryPrice: '1', exitPrice: '1.05', ...o } as SignalParityGoldenTrade);
const gen = (o: Partial<GeneratedTrade> = {}): GeneratedTrade => ({ entryTs: 10_000_000, exitTs: 10_060_000, side: 'long', closeReason: 'take_profit', entryFillPrice: 1, exitFillPrice: 1.05, pnlPct: 5.0, ...o } as GeneratedTrade);

describe('scorableGolden', () => {
  it('drops trades whose entry is within warmup of the first row', () => {
    const first = 0;
    const kept = scorableGolden([g({ openedAtMs: 30 * 60_000 }), g({ tradeId: 'g2', openedAtMs: 90 * 60_000 })], first, WARMUP);
    expect(kept.map((t) => t.tradeId)).toEqual(['g2']);
  });
});

describe('matchTrades', () => {
  const win = { startMs: 0, endMs: 1e13 };
  it('exact signals + pnl in tol → ok', () => {
    expect(matchTrades([g()], [gen()], win).ok).toBe(true);
  });
  it('shifted entry bar → fail', () => {
    expect(matchTrades([g()], [gen({ entryTs: 10_000_000 + 60_000 })], win).ok).toBe(false);
  });
  it('wrong close-reason bucket → fail', () => {
    expect(matchTrades([g()], [gen({ closeReason: 'stop_loss', pnlPct: 5.0 })], win).ok).toBe(false);
  });
  it('pnl beyond epsilon → fail', () => {
    expect(matchTrades([g()], [gen({ pnlPct: 5.2 })], win, 0.05).ok).toBe(false);
  });
  it('extra generated entry in-window (over-trigger) → fail', () => {
    expect(matchTrades([g()], [gen(), gen({ entryTs: 11_000_000, exitTs: 11_060_000 })], win).ok).toBe(false);
  });
  it('missing generated match (under-trigger) → fail', () => {
    expect(matchTrades([g()], [], win).ok).toBe(false);
  });
  it('other↔other match is flagged', () => {
    const r = matchTrades([g({ closeReason: 'weird', closeReasonRaw: null })], [gen({ closeReason: 'mystery' })], win);
    expect(r.flaggedOtherOther.length).toBe(1);
  });
});
