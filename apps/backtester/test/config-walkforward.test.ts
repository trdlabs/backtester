import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('walk-forward config (E3b)', () => {
  it('defaults off with maxFolds 20', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.walkForward).toBe(false);
    expect(cfg.walkForwardMaxFolds).toBe(20);
  });
  it('enables only for exact "true" and parses a safe-int max', () => {
    const cfg = loadConfig({ BACKTESTER_WALK_FORWARD_ENABLED: 'true', BACKTESTER_WALK_FORWARD_MAX_FOLDS: '8' } as NodeJS.ProcessEnv);
    expect(cfg.walkForward).toBe(true);
    expect(cfg.walkForwardMaxFolds).toBe(8);
  });
  it('falls back to 20 on a non-integer / <1 max', () => {
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: '2.5' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: '0' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: 'abc' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
  });
});
