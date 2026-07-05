// Pins the cache's "share, don't clone" invariant: the momentum runner must not mutate the candle
// arrays it reads, so a single cached MaterializedDataset can safely serve many runs. Engine-
// independent on purpose (imports only the legacy runner + fixture data port), mirroring the
// momentum-guardrail setup.

import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { FixtureDataPort, materialize } from '../src/data/reader.js';
import { runBacktest } from '../src/runner/run-backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');

const REQ: BacktestRunRequest = {
  runId: 'mut-run',
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
};

async function loadDataset() {
  const port = new FixtureDataPort(FIXTURES_DIR);
  const reader = await port.openDataset('smoke-btc-1m');
  if (!reader) throw new Error('fixture missing');
  return materialize(reader, 'smoke-btc-1m', {
    tsFrom: 0,
    tsTo: Number.MAX_SAFE_INTEGER,
    symbols: ['BTCUSDT'],
  });
}

describe('momentum candle arrays are not mutated by the runner (cache share invariant)', () => {
  it('leaves the shared candle array reference- and content-identical after a run', async () => {
    const dataset = await loadDataset();
    const beforeRef = dataset.candles('BTCUSDT');
    const beforeLen = beforeRef.length;
    expect(beforeLen).toBeGreaterThan(0); // guard: a non-empty fixture, else the assertions below are vacuous
    const beforeJson = JSON.stringify(beforeRef);

    await runBacktest(REQ, { dataset });

    const after = dataset.candles('BTCUSDT');
    expect(after).toBe(beforeRef); // same array instance — not replaced
    expect(after.length).toBe(beforeLen); // no push/pop/splice
    expect(JSON.stringify(after)).toBe(beforeJson); // no in-place field edits or re-sort
  });
});
