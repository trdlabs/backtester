import { describe, expect, it } from 'vitest';
import { canonicalizeEvidenceBody as canon } from '../src/evidence/canonical.js';

describe('canonicalizeEvidenceBody — exact platform stableStringify mirror', () => {
  it('sorts object keys lexicographically', () => {
    expect(canon({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('recurses into nested objects and arrays, no spaces', () => {
    expect(canon({ window: { toMs: 2, fromMs: 1 }, symbols: ['B', 'A'] }))
      .toBe('{"symbols":["B","A"],"window":{"fromMs":1,"toMs":2}}');
  });
  it('serializes primitives via JSON.stringify, no trailing newline', () => {
    expect(canon('x')).toBe('"x"');
    expect(canon(42)).toBe('42');
    expect(canon(null)).toBe('null');
    expect(canon(true)).toBe('true');
  });
  it('keeps empty array as [] (not null)', () => {
    expect(canon({ symbols: [] })).toBe('{"symbols":[]}');
  });
  it('matches the full evidence-body shape byte-for-byte', () => {
    const body = {
      schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
      verdict: 'passed', datasetRef: 'ds', window: { fromMs: 1, toMs: 2 },
      symbols: ['AUSDT'], timeframe: '1m', keyId: 'bt-ed25519-0',
    };
    expect(canon(body)).toBe(
      '{"backtesterRunId":"r1","bundleHash":"sha256:ab","datasetRef":"ds","keyId":"bt-ed25519-0","schema":"backtest-evidence/v1","symbols":["AUSDT"],"timeframe":"1m","verdict":"passed","window":{"fromMs":1,"toMs":2}}',
    );
  });
});
