import { describe, expect, it } from 'vitest';
// Build a minimal 2-symbol trusted run via the same harness the existing runner/golden tests use.
// Reuse an existing multi-symbol fixture + RunDeps builder from a sibling runner test
// (twin-equivalence-multisymbol.test.ts) rather than re-deriving.
import { runBacktest } from '../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

describe('bar-major execution flip', () => {
  it('N=1 is byte-identical to symbol-major (flag has no effect on one symbol)', async () => {
    const req = makeRequest(['BTCUSDT']);
    const off = await runBacktest(req, makeMultiSymbolDeps({ barMajor: false }));
    const on = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(on)).toBe(resultHash(off));
  });

  it('N>1 bar-major is deterministic across two identical runs', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const a = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const b = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(a)).toBe(resultHash(b));
  });

  it('N>1 bar-major differs from symbol-major (semantics changed, as designed)', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const major = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const symbolMajor = await runBacktest(req, makeMultiSymbolDeps({ barMajor: false }));
    expect(resultHash(major)).not.toBe(resultHash(symbolMajor));
  });
});
