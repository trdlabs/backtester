// Characterization tests for the RiskEngine — the single hard-authority layer before execution
// (018, FR-016/017/018). Coverage flagged it at ~28%; the accept/clamp/reject branches for exit
// normalization (R3), update_protection (US3) and add_to_position limits (R4) were unexercised.
// Pinned through the ready-made profiles in profiles.ts. No source change.

import { describe, expect, it } from 'vitest';
import type { StrategyDecision } from '@trading/research-contracts/research';
import { RiskEngine } from '../src/engine/risk';
import { DCA_RISK, DEFAULT_RISK, LONG_ONLY_RISK, TIGHT_ADD_RISK, TIGHT_STOP_RISK } from '../src/engine/profiles';

const enter = (extra: Partial<StrategyDecision> = {}): StrategyDecision =>
  ({ kind: 'enter', side: 'short', ...extra }) as StrategyDecision;
const exit = (percent?: number): StrategyDecision => ({ kind: 'exit', target: 'pos-1', ...(percent !== undefined ? { percent } : {}) });
const updateProtection = (stop?: number, take?: number): StrategyDecision => ({ kind: 'update_protection', ...(stop !== undefined ? { stop } : {}), ...(take !== undefined ? { take } : {}) });
const add = (mode: 'dca' | 'scale_in', sizingHint?: number): StrategyDecision => ({ kind: 'add_to_position', mode, ...(sizingHint !== undefined ? { sizingHint } : {}) });

describe('RiskEngine — enter', () => {
  it('accepts a within-profile entry with full-notional sizing', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(enter(), 0, 0)).toMatchObject({
      action: 'accept',
      sizingPct: 1.0,
      record: { decisionKind: 'enter', action: 'accept', reason: 'within_risk_profile', barIndex: 0 },
    });
  });

  it('rejects a side not in allowedSides', () => {
    expect(new RiskEngine(LONG_ONLY_RISK).evaluate(enter({ side: 'short' }), 0, 0)).toMatchObject({
      action: 'reject',
      record: { decisionKind: 'enter', action: 'reject', reason: 'side_not_allowed:short' },
    });
  });

  it('rejects when openPositions has reached maxConcurrentPositions (portfolio-wide)', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(enter(), 3, 1)).toMatchObject({
      action: 'reject',
      record: { action: 'reject', reason: 'max_concurrent_positions' },
    });
  });

  it('clamps an out-of-bounds stop hint to the profile bound and records the clamp', () => {
    expect(new RiskEngine(TIGHT_STOP_RISK).evaluate(enter({ stop: 0.5 }), 0, 0)).toMatchObject({
      action: 'clamp',
      sizingPct: 1.0,
      stop: 0.02, // clamped to stopBounds.max
      record: { action: 'clamp', reason: 'hints_clamped', clamped: [{ field: 'stop', from: 0.5, to: 0.02 }] },
    });
  });

  it('accepts in-bounds protection hints and carries the normalized stop/take', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(enter({ stop: 0.05, take: 0.1 }), 0, 0)).toMatchObject({
      action: 'accept',
      stop: 0.05,
      take: 0.1,
      record: { reason: 'within_risk_profile' },
    });
  });
});

describe('RiskEngine — exit normalization (R3)', () => {
  it('full exit (no percent) is always accepted', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(exit(), 1, 1)).toMatchObject({
      action: 'accept',
      record: { decisionKind: 'exit', reason: 'exit_always_allowed' },
    });
  });

  it('rejects a non-positive or non-finite exit percent', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(exit(0), 1, 1)).toMatchObject({ action: 'reject', record: { reason: 'invalid_exit_percent' } });
    expect(new RiskEngine(DEFAULT_RISK).evaluate(exit(Number.NaN), 1, 1)).toMatchObject({ action: 'reject', record: { reason: 'invalid_exit_percent' } });
  });

  it('clamps percent ≥ 100 to a full exit', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(exit(150), 1, 1)).toMatchObject({
      action: 'clamp',
      record: { reason: 'exit_percent_clamped', clamped: [{ field: 'percent', from: 150, to: 100 }] },
    });
  });

  it('accepts 0<p<100 as a partial exit with closeFraction = p/100', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(exit(25), 1, 1)).toMatchObject({
      action: 'accept',
      closeFraction: 0.25,
      record: { reason: 'exit_partial_allowed' },
    });
  });
});

describe('RiskEngine — update_protection (US3)', () => {
  it('rejects update_protection while flat (no open position)', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(updateProtection(0.05), 2, 0)).toMatchObject({
      action: 'reject',
      record: { decisionKind: 'update_protection', reason: 'update_without_position' },
    });
  });

  it('accepts an in-bounds protection update', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate(updateProtection(0.05), 2, 1)).toMatchObject({
      action: 'accept',
      stop: 0.05,
      record: { action: 'accept', reason: 'protection_updated' },
    });
  });

  it('clamps an out-of-bounds protection update', () => {
    expect(new RiskEngine(TIGHT_STOP_RISK).evaluate(updateProtection(0.5), 2, 1)).toMatchObject({
      action: 'clamp',
      stop: 0.02,
      record: { action: 'clamp', reason: 'hints_clamped', clamped: [{ field: 'stop', from: 0.5, to: 0.02 }] },
    });
  });
});

describe('RiskEngine — add_to_position limits (R4)', () => {
  const ctx = { size: 0, entryPrice: 0, addCount: 0, cash: 1000 };

  it('rejects add while flat or with no position context', () => {
    expect(new RiskEngine(DCA_RISK).evaluate(add('dca'), 0, 0, ctx)).toMatchObject({ action: 'reject', record: { reason: 'add_without_position' } });
    expect(new RiskEngine(DCA_RISK).evaluate(add('dca'), 0, 1, undefined)).toMatchObject({ action: 'reject', record: { reason: 'add_without_position' } });
  });

  it('rejects when the mode is not permitted by the profile (no limits declared)', () => {
    // DEFAULT_RISK declares neither dcaLimits nor scaleInLimits.
    expect(new RiskEngine(DEFAULT_RISK).evaluate(add('dca'), 0, 1, ctx)).toMatchObject({ action: 'reject', record: { reason: 'dca_not_permitted' } });
    expect(new RiskEngine(DEFAULT_RISK).evaluate(add('scale_in'), 0, 1, ctx)).toMatchObject({ action: 'reject', record: { reason: 'scale_in_not_permitted' } });
  });

  it('rejects once maxAdds is exhausted', () => {
    expect(new RiskEngine(TIGHT_ADD_RISK).evaluate(add('dca'), 0, 1, { ...ctx, addCount: 1 })).toMatchObject({
      action: 'reject',
      record: { reason: 'dca_limit_exceeded' },
    });
  });

  it('clamps an oversized sizingHint to maxAddNotionalPct', () => {
    // DCA_RISK.dcaLimits.maxAddNotionalPct = 0.25; requested 0.5 ⇒ clamp to 0.25.
    expect(new RiskEngine(DCA_RISK).evaluate(add('dca', 0.5), 0, 1, ctx)).toMatchObject({
      action: 'clamp',
      mode: 'dca',
      sizingPct: 0.25,
      record: { reason: 'add_notional_clamped', clamped: [{ field: 'addNotionalPct', from: 0.5, to: 0.25 }] },
    });
  });

  it('accepts an add within all limits', () => {
    expect(new RiskEngine(DCA_RISK).evaluate(add('dca', 0.2), 0, 1, ctx)).toMatchObject({
      action: 'accept',
      mode: 'dca',
      sizingPct: 0.2,
      record: { reason: 'add_within_limits' },
    });
  });
});

describe('RiskEngine — other kinds', () => {
  it('defensively accepts kinds that never reach risk (idle) as a no-op', () => {
    expect(new RiskEngine(DEFAULT_RISK).evaluate({ kind: 'idle' }, 5, 0)).toMatchObject({
      action: 'accept',
      record: { decisionKind: 'idle', action: 'accept', reason: 'no_op' },
    });
  });
});
