import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { CONTRACT_VERSION, PLATFORM_CONTRACT_VERSION } from '@trading/research-contracts';
import { schemaAsset, SCHEMA_IDS } from '@trading/research-contracts/research';

describe('additive 017 contract merge', () => {
  it('still accepts the legacy signals request shape unchanged', () => {
    const legacy: BacktestRunRequest = {
      runId: 'r0', mode: 'research', moduleRef: { id: 'smoke', version: '1.0.0' },
      datasetRef: 'smoke-btc-1m', symbols: ['BTCUSDT'], timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed: 42, metrics: [],
    };
    expect(legacy.seed).toBe(42);
    expect((legacy as { engine?: string }).engine).toBeUndefined();
  });

  it('accepts an explicit overlay-engine request with 017 fields', () => {
    const overlay: BacktestRunRequest = {
      runId: 'r1', mode: 'research', moduleRef: { id: 'shortAfterPump', version: '1.0.0' },
      overlayRefs: [{ id: 'earlyExitShortAfterPump', version: '1.0.0' }],
      datasetRef: 'smoke-btc-1m', symbols: ['BTCUSDT'], timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed: 42, metrics: [], engine: 'overlay',
    };
    expect(overlay.engine).toBe('overlay');
    expect(overlay.overlayRefs?.length).toBe(1);
  });
});

it('CONTRACT_VERSION is in lockstep with the lifted platform anchor', () => {
  expect(CONTRACT_VERSION).toBe(PLATFORM_CONTRACT_VERSION);
});

it('loads the 017 strategy-decision schema asset with its $id intact', () => {
  const schema = schemaAsset('strategy-decision');
  expect(schema.$id).toBe(SCHEMA_IDS['strategy-decision']);
  expect(typeof schema).toBe('object');
});
