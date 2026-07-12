import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('holdout config (E4a)', () => {
  it('defaults off', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).holdout).toBe(false);
  });
  it('enables only for exact "true"', () => {
    const cfg = loadConfig({
      BACKTESTER_HOLDOUT_ENABLED: 'true',
      BACKTESTER_HOLDOUT_FRACTION: '0.2',
    } as NodeJS.ProcessEnv);
    expect(cfg.holdout).toBe(true);
    expect(cfg.holdoutFraction).toBe(0.2);
  });
  it('fail-fast when enabled with an out-of-range fraction (no silent clamp)', () => {
    for (const bad of ['0', '1', '1.5', '-0.1', 'x']) {
      expect(() =>
        loadConfig({ BACKTESTER_HOLDOUT_ENABLED: 'true', BACKTESTER_HOLDOUT_FRACTION: bad } as NodeJS.ProcessEnv),
      ).toThrow(/BACKTESTER_HOLDOUT_FRACTION/);
    }
  });
  it('fail-fast when enabled without a fraction', () => {
    expect(() => loadConfig({ BACKTESTER_HOLDOUT_ENABLED: 'true' } as NodeJS.ProcessEnv)).toThrow(
      /BACKTESTER_HOLDOUT_FRACTION/,
    );
  });
});
