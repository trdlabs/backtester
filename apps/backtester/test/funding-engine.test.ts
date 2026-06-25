import { describe, expect, it } from 'vitest';
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
});

describe('Portfolio.chargeFunding', () => {
  it('positive cost reduces cash; equityAt(flat) reflects it', () => {
    const p = new Portfolio(1000);
    p.chargeFunding(2.5);
    expect(p.cash).toBeCloseTo(997.5, 8);
    expect(p.equityAt(123)).toBeCloseTo(997.5, 8); // flat → equity == cash
  });

  it('negative cost (credit) increases cash', () => {
    const p = new Portfolio(1000);
    p.chargeFunding(-1.25);
    expect(p.cash).toBeCloseTo(1001.25, 8);
  });
});

import type { FundingLedgerEntry } from '../src/engine/runner';

describe('funding ledger wiring', () => {
  it('FundingLedgerEntry shape is exported and structurally usable', () => {
    const e: FundingLedgerEntry = { barIndex: 1, ts: 1781767440000, rate: -0.0002, covered: true, cost: -0.01 };
    expect(e.covered).toBe(true);
    expect(e.cost).toBeLessThan(0);
  });
});
