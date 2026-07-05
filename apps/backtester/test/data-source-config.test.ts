import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('dataSource config', () => {
  it('defaults to the in-process fixture reader when no env is set', () => {
    expect(loadConfig({}).dataSource).toBe('fixture');
  });

  it('recognises BACKTESTER_DATA_SOURCE=http', () => {
    expect(loadConfig({ BACKTESTER_DATA_SOURCE: 'http' }).dataSource).toBe('http');
  });

  it('recognises BACKTESTER_DATA_SOURCE=mock', () => {
    expect(loadConfig({ BACKTESTER_DATA_SOURCE: 'mock' }).dataSource).toBe('mock');
  });

  it('recognises BACKTESTER_DATA_SOURCE=real (env cutover to the live platform)', () => {
    expect(loadConfig({
      BACKTESTER_DATA_SOURCE: 'real',
      BACKTESTER_REAL_PLATFORM_URL: 'http://127.0.0.1:8088',
      BACKTESTER_REAL_PLATFORM_TOKEN: 'tok',
    }).dataSource).toBe('real');
  });

  it('falls back to fixture for any unknown value', () => {
    expect(loadConfig({ BACKTESTER_DATA_SOURCE: 'nonsense' }).dataSource).toBe('fixture');
  });

  it('real and mock have separate URL/token env pairs (no longer shared)', () => {
    const c = loadConfig({
      BACKTESTER_DATA_SOURCE: 'real',
      BACKTESTER_REAL_PLATFORM_URL: 'http://89.124.86.84:8088',
      BACKTESTER_REAL_PLATFORM_TOKEN: 'tok',
    });
    expect(c.dataSource).toBe('real');
    expect(c.realPlatformUrl).toBe('http://89.124.86.84:8088');
    expect(c.realPlatformToken).toBe('tok');
    expect(c.mockPlatformUrl).toBeUndefined();
    expect(c.mockPlatformToken).toBeUndefined();
  });
});

describe('evidenceSigningKeyPem config', () => {
  it('reads BT_EVIDENCE_SIGNING_KEY into evidenceSigningKeyPem when set', () => {
    const cfg = loadConfig({ BT_EVIDENCE_SIGNING_KEY: 'PEMDATA' });
    expect(cfg.evidenceSigningKeyPem).toBe('PEMDATA');
  });

  it('leaves evidenceSigningKeyPem undefined when BT_EVIDENCE_SIGNING_KEY is absent', () => {
    expect(loadConfig({}).evidenceSigningKeyPem).toBeUndefined();
  });
});
