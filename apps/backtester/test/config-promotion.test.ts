import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
const ON = { BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true', BACKTESTER_HOLDOUT_ENABLED: 'true', BACKTESTER_HOLDOUT_FRACTION: '0.2' };
describe('promotion-gate config (E4b)', () => {
  it('defaults off', () => { expect(loadConfig({} as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(false); });
  it('enables only for exact "true" (with holdout enabled)', () => {
    expect(loadConfig(ON as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(true);
    expect(loadConfig({ ...ON, BACKTESTER_PROMOTION_HOLDOUT_GATE: '1' } as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(false);
  });
  it('fail-fast: enabling the gate REQUIRES holdout enabled + a valid fraction', () => {
    expect(() => loadConfig({ BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true' } as NodeJS.ProcessEnv)).toThrow(/holdout/i);
    expect(() => loadConfig({ BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true', BACKTESTER_HOLDOUT_ENABLED: 'true' } as NodeJS.ProcessEnv)).toThrow(/fraction|holdout/i);
  });
});
