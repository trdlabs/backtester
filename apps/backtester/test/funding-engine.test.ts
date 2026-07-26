import { describe, expect, it } from 'vitest';
import type { FundingLedgerEntry } from '../src/engine/runner';
import {
  DEFAULT_EXEC,
  REALISM_EXEC,
  SUPPORTED_FUNDING_MODEL_KINDS,
  type PerMinuteProrateFundingModel,
} from '../src/engine/profiles';
import { ExecutionSimulator } from '../src/engine/execution';
import { Portfolio } from '../src/engine/portfolio';

describe('REALISM_EXEC profile + funding-model catalog', () => {
  it('per_minute_prorate is the only supported funding kind (closed catalog)', () => {
    expect([...SUPPORTED_FUNDING_MODEL_KINDS]).toEqual(['per_minute_prorate']);
  });

  it('REALISM_EXEC carries next_bar_open + fee/slippage bps + per_minute_prorate funding (8h)', () => {
    expect((REALISM_EXEC.fillModel as { kind: string }).kind).toBe('next_bar_open');
    expect((REALISM_EXEC.feeModel as { bps: number }).bps).toBe(5);
    expect((REALISM_EXEC.slippageModel as { bps: number }).bps).toBe(5);
    const fm = REALISM_EXEC.fundingModel as PerMinuteProrateFundingModel;
    expect(fm.kind).toBe('per_minute_prorate');
    expect(fm.intervalHours).toBe(8);
  });

  it('DEFAULT_EXEC carries NO fundingModel (opt-in: default path unchanged)', () => {
    expect(DEFAULT_EXEC.fundingModel).toBeUndefined();
  });
});

describe('ExecutionSimulator — funding accessors + guard', () => {
  it('fundingEnabled() is false for DEFAULT_EXEC, true for REALISM_EXEC', () => {
    expect(new ExecutionSimulator(DEFAULT_EXEC).fundingEnabled()).toBe(false);
    expect(new ExecutionSimulator(REALISM_EXEC).fundingEnabled()).toBe(true);
  });

  it('fundingIntervalHours() returns the model interval (8)', () => {
    expect(new ExecutionSimulator(REALISM_EXEC).fundingIntervalHours()).toBe(8);
  });

  it('rejects an unknown fundingModel.kind (fail-fast, no silent fallback)', () => {
    const bad = { ...REALISM_EXEC, fundingModel: { kind: 'continuous_apr', intervalHours: 8 } };
    expect(() => new ExecutionSimulator(bad)).toThrow(/funding/i);
  });

  it('fundingIntervalHours() throws when funding is not enabled', () => {
    expect(() => new ExecutionSimulator(DEFAULT_EXEC).fundingIntervalHours()).toThrow();
  });
});

// Ф3 / SSOT decision 4 — `chargeFunding` (cash-only) became `settleFunding`: a settlement moves
// cash AND accrues against the open position, so the closing `Trade` carries the holding cost in
// `realizedPnl`. Two consequences pinned here: funding without an open position is now an error
// rather than a silently-dropped charge, and the accrual reaches the trade.
describe('Portfolio.settleFunding (SSOT decision 4)', () => {
  const held = (): Portfolio => {
    const p = new Portfolio(1000);
    p.placePending({ id: 'o1', symbol: 'BTCUSDT', side: 'long', intent: 'open', decisionBarIndex: 0, notional: 500 });
    p.settleOpen({ fillPrice: 100, fee: 0, size: 5, barIndex: 1, ts: 1_000 });
    return p;
  };

  it('positive cost is an outflow: cash falls by exactly the cost', () => {
    const p = held();
    const before = p.cash;
    p.settleFunding(2.5);
    expect(p.cash).toBeCloseTo(before - 2.5, 8);
  });

  it('negative cost (credit) is an inflow of exactly the credit', () => {
    const p = held();
    const before = p.cash;
    p.settleFunding(-1.25);
    expect(p.cash).toBeCloseTo(before + 1.25, 8);
  });

  it('accrues against the position: the closing trade carries fundingPaid in realizedPnl', () => {
    const p = held();
    p.settleFunding(2.5);
    expect(p.position?.fundingAccrued).toBeCloseTo(2.5, 8);
    const flatClose = new Portfolio(1000);
    flatClose.placePending({ id: 'o1', symbol: 'BTCUSDT', side: 'long', intent: 'open', decisionBarIndex: 0, notional: 500 });
    flatClose.settleOpen({ fillPrice: 100, fee: 0, size: 5, barIndex: 1, ts: 1_000 });
    const free = flatClose.closePosition({ fillPrice: 100, fee: 0, barIndex: 2, ts: 2_000 }, 'strategy_exit');
    const charged = p.closePosition({ fillPrice: 100, fee: 0, barIndex: 2, ts: 2_000 }, 'strategy_exit');
    expect(charged.fundingPaid).toBeCloseTo(2.5, 8);
    // The whole cost of holding lands in realizedPnl — that IS decision 4 against the donor.
    expect(free.realizedPnl - charged.realizedPnl).toBeCloseTo(2.5, 8);
  });

  it('a settlement with no open position is an error, not a dropped charge', () => {
    expect(() => new Portfolio(1000).settleFunding(2.5)).toThrow(/no open position/);
  });
});

describe('funding ledger wiring', () => {
  it('FundingLedgerEntry shape is exported and structurally usable', () => {
    const e: FundingLedgerEntry = { barIndex: 1, ts: 1781767440000, rate: -0.0002, covered: true, cost: -0.01 };
    expect(e.covered).toBe(true);
    expect(e.cost).toBeLessThan(0);
  });
});
