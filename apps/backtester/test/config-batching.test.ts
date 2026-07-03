import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('bar-batching config', () => {
  it('defaults: off, 64 bars', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.barBatching).toBe(false);
    expect(c.batchBars).toBe(64);
  });
  it('parses and clamps', () => {
    const c = loadConfig({ BACKTESTER_BAR_BATCHING: 'true', BACKTESTER_BATCH_BARS: '1' } as NodeJS.ProcessEnv);
    expect(c.barBatching).toBe(true);
    expect(c.batchBars).toBe(2); // clamped ≥2
    expect(loadConfig({ BACKTESTER_BATCH_BARS: 'garbage' } as NodeJS.ProcessEnv).batchBars).toBe(64);
  });
});
