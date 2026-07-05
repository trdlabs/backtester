import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('universe-session config', () => {
  it('defaults: flag off, sane numeric knobs', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.universeSession).toBe(false);
    expect(c.universeMaxN).toBe(64);
    expect(c.universeMemBaseMb).toBe(128);
    expect(c.universeMemPerSymbolMb).toBe(8);
  });
  it('flag true only for exact "true"', () => {
    expect(loadConfig({ BACKTESTER_UNIVERSE_SESSION: 'true' } as NodeJS.ProcessEnv).universeSession).toBe(true);
    expect(loadConfig({ BACKTESTER_UNIVERSE_SESSION: '1' } as NodeJS.ProcessEnv).universeSession).toBe(false);
  });
  it('numeric knobs parse with NaN-guard floors', () => {
    expect(loadConfig({ BACKTESTER_UNIVERSE_MAX_N: '300' } as NodeJS.ProcessEnv).universeMaxN).toBe(300);
    expect(loadConfig({ BACKTESTER_UNIVERSE_MAX_N: 'x' } as NodeJS.ProcessEnv).universeMaxN).toBe(64);   // NaN → default
    expect(loadConfig({ BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB: '16' } as NodeJS.ProcessEnv).universeMemPerSymbolMb).toBe(16);
  });
});
