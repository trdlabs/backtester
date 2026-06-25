import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXEC,
  REALISM_EXEC,
  SUPPORTED_FUNDING_MODEL_KINDS,
  type PerMinuteProrateFundingModel,
} from '../src/engine/profiles';

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
