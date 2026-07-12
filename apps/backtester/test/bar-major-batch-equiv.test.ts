// apps/backtester/test/bar-major-batch-equiv.test.ts
// Reuse the trusted multi-symbol fixture from bar-major-runner.test.ts (helpers/bar-major-fixture).
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

describe('bar-major batch 3-phase reorder is byte-identical to Slice A interleave', () => {
  it('trusted: barMajor + barMajorBatch ON == barMajor (batch OFF) result_hash (N=2)', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const interleave = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const batched = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true, barMajorBatch: true }));
    expect(resultHash(batched)).toBe(resultHash(interleave));
  });
});
