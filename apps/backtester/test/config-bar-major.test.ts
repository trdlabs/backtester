import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_BAR_MAJOR config', () => {
  it('defaults barMajor to false', () => {
    const cfg = loadConfig({});
    expect(cfg.barMajor).toBe(false);
  });

  it('parses barMajor=true', () => {
    const cfg = loadConfig({ BACKTESTER_BAR_MAJOR: 'true' });
    expect(cfg.barMajor).toBe(true);
  });

  it('fails fast when bar-major AND bar-batching are both enabled', () => {
    expect(() => loadConfig({ BACKTESTER_BAR_MAJOR: 'true', BACKTESTER_BAR_BATCHING: 'true' })).toThrow(
      'BACKTESTER_BAR_MAJOR and BACKTESTER_BAR_BATCHING cannot both be enabled',
    );
  });
});
