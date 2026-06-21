// Characterization tests for ExecutionSimulator — the audit flagged the private fillPrice/fee as
// untested; they are pinned here through the public computeOpenFill / computeCloseFill surface.
// DEFAULT_EXEC = next_bar_open, slippage 5 bps, fee 10 bps. No source change; no golden touched.

import { describe, expect, it } from 'vitest';
import { ExecutionSimulator } from '../src/engine/execution';
import { DEFAULT_EXEC, UNSUPPORTED_FILL_EXEC } from '../src/engine/profiles';

const sim = new ExecutionSimulator(DEFAULT_EXEC);

describe('ExecutionSimulator — slippage direction + fee (via public fills)', () => {
  it('open long (buy) moves the fill price UP by slippage; fee = notional·feeBps/1e4', () => {
    const f = sim.computeOpenFill('long', 100, 0.5, 1000);
    expect(f.fillPrice).toBeCloseTo(100.05, 8); // 100·(1 + 5/1e4)
    expect(f.baseOpen).toBe(100);
    expect(f.slippageBps).toBe(5);
    expect(f.fee).toBeCloseTo(0.5, 8); // notional 500 · 10/1e4
    expect(f.size).toBeCloseTo(500 / 100.05, 6); // notional / fillPrice
    expect(f.size * f.fillPrice).toBeCloseTo(500, 4); // round-trips to notional
  });

  it('open short (sell) moves the fill price DOWN by slippage', () => {
    const f = sim.computeOpenFill('short', 100, 0.5, 1000);
    expect(f.fillPrice).toBeCloseTo(99.95, 8); // 100·(1 − 5/1e4)
    expect(f.fee).toBeCloseTo(0.5, 8);
  });

  it('close long (sell) uses sell-side slippage; fee on the close notional', () => {
    const f = sim.computeCloseFill('long', 100, 4);
    expect(f.fillPrice).toBeCloseTo(99.95, 8);
    expect(f.baseOpen).toBe(100);
    expect(f.fee).toBeCloseTo((99.95 * 4 * 10) / 1e4, 8); // 0.3998
  });

  it('close short (buy) uses buy-side slippage', () => {
    const f = sim.computeCloseFill('short', 100, 4);
    expect(f.fillPrice).toBeCloseTo(100.05, 8);
    expect(f.fee).toBeCloseTo((100.05 * 4 * 10) / 1e4, 8); // 0.4002
  });

  it('protection fill delegates to computeCloseFill', () => {
    expect(sim.computeProtectionFill('long', 100, 4)).toEqual(sim.computeCloseFill('long', 100, 4));
  });

  it('rejects an unsupported fillModel.kind at construction (fail-fast, no silent fallback)', () => {
    expect(() => new ExecutionSimulator(UNSUPPORTED_FILL_EXEC)).toThrow(/unsupported fillModel\.kind/);
  });
});
