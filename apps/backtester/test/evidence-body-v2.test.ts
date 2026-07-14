import { describe, expect, it } from 'vitest';
import { buildEvidenceBodyV2 } from '../src/evidence/body-v2.js';

describe('buildEvidenceBodyV2', () => {
  it('assembles a flat schema:v2 body with sorted symbols + held-out binding', () => {
    const body = buildEvidenceBodyV2({
      backtesterRunId: 'run-1', bundleHash: 'sha256:b', keyId: 'k',
      datasetRef: 'ds', executionWindow: { fromMs: 0, toMs: 100 }, symbols: ['ETH', 'BTC'], timeframe: '1m',
      evaluationWindow: { fromMs: 60, toMs: 100 },
      candidateHoldoutMetrics: { sharpe: 2 }, curatedHoldoutMetrics: { sharpe: 2 },
      thresholds: { minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 },
      attemptNumber: 3, qualificationEpochKey: 'ek',
      candidateResultHash: 'sha256:c', curatedResultHash: 'sha256:cu', curatedBaselineRef: { id: 'base', version: '1' } as any,
      qualification: { coverage: { from: 'a', to: 'b' }, fraction: 0.4, policyVersion: 'p1', datasetFingerprint: 'dsf' },
    });
    expect(body.schema).toBe('backtest-evidence/v2');
    expect(body.verdict).toBe('passed');
    expect(body.symbols).toEqual(['BTC', 'ETH']); // sorted
    expect(body.window).toEqual({ fromMs: 0, toMs: 100 });
    expect(body.evaluationWindow).toEqual({ fromMs: 60, toMs: 100 });
    expect(body.attemptNumber).toBe(3);
    expect(body.curatedBaselineRef).toBe('base@1'); // stringified id@version
  });
});
