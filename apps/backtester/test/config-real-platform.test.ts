import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const BASE = { BACKTESTER_DATA_SOURCE: 'real' } as NodeJS.ProcessEnv;

describe('loadConfig real-platform validation', () => {
  it('throws a stable error when real is selected without URL/token', () => {
    expect(() => loadConfig({ ...BASE }))
      .toThrow('BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real');
  });

  it('throws when URL present but token missing', () => {
    expect(() => loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: 'http://127.0.0.1:8088' }))
      .toThrow('BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real');
  });

  it('treats whitespace-only URL/token as misconfig', () => {
    expect(() => loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: '  ', BACKTESTER_REAL_PLATFORM_TOKEN: '\t' }))
      .toThrow('required when BACKTESTER_DATA_SOURCE=real');
  });

  it('loads a fully-configured real source', () => {
    const cfg = loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: 'http://127.0.0.1:8088', BACKTESTER_REAL_PLATFORM_TOKEN: 'raw-secret' });
    expect(cfg.dataSource).toBe('real');
    expect(cfg.realPlatformUrl).toBe('http://127.0.0.1:8088');
    expect(cfg.realPlatformToken).toBe('raw-secret');
  });

  it('does not validate real vars when data source is not real', () => {
    expect(() => loadConfig({ BACKTESTER_DATA_SOURCE: 'fixture' })).not.toThrow();
  });

  it('trims surrounding whitespace from a padded-but-nonempty URL/token at store time', () => {
    const cfg = loadConfig({
      ...BASE,
      BACKTESTER_REAL_PLATFORM_URL: ' http://127.0.0.1:8088 ',
      BACKTESTER_REAL_PLATFORM_TOKEN: ' tok ',
    });
    expect(cfg.realPlatformUrl).toBe('http://127.0.0.1:8088');
    expect(cfg.realPlatformToken).toBe('tok');
  });
});
