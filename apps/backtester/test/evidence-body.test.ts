import { describe, expect, it } from 'vitest';
import { buildEvidenceBody } from '../src/evidence/body.js';
import { canonicalizeEvidenceBody } from '../src/evidence/canonical.js';

const SCOPE = { datasetRef: 'ds', window: { fromMs: 10, toMs: 20 }, symbols: ['BUSDT', 'AUSDT'], timeframe: '1m' };

describe('buildEvidenceBody', () => {
  it('emits the fixed shape with schema constant and sorted symbols', () => {
    const body = buildEvidenceBody({ backtesterRunId: 'r1', bundleHash: 'sha256:ab', verdict: 'passed', scope: SCOPE, keyId: 'k' });
    expect(body.schema).toBe('backtest-evidence/v1');
    expect(body.symbols).toEqual(['AUSDT', 'BUSDT']); // sorted, deterministic
    expect(body).toEqual({
      schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
      verdict: 'passed', datasetRef: 'ds', window: { fromMs: 10, toMs: 20 },
      symbols: ['AUSDT', 'BUSDT'], timeframe: '1m', keyId: 'k',
    });
  });
  it('never emits undefined / missing keys (no key whose canonical value is "undefined")', () => {
    const body = buildEvidenceBody({ backtesterRunId: 'r', bundleHash: 'sha256:0', verdict: 'failed', scope: { ...SCOPE, symbols: [] }, keyId: 'k' });
    expect(canonicalizeEvidenceBody(body)).not.toContain('undefined');
    expect(body.symbols).toEqual([]); // empty array, not null
  });
});
