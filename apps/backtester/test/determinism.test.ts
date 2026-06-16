import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { contentRef } from '../src/determinism/hash';
import { datasetFingerprint, FixtureDataPort, materialize } from '../src/data/reader';
import { runBacktest } from '../src/runner/run-backtest';
import { FIXTURES_DIR } from './helpers';

const REQ: BacktestRunRequest = {
  runId: 'det-run',
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

describe('determinism', () => {
  it('produces a byte-identical result_hash across runs', async () => {
    const h1 = contentRef(runBacktest(REQ, { dataset: await loadDataset() }));
    const h2 = contentRef(runBacktest(REQ, { dataset: await loadDataset() }));
    expect(h1).toEqual(h2);
  });

  it('locks the golden result_hash (regression guard)', async () => {
    const result = runBacktest(REQ, { dataset: await loadDataset() });
    expect(contentRef(result)).toMatchInlineSnapshot(`"sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba"`);
  });

  it('a different seed changes the result_hash (rng is wired)', async () => {
    const base = contentRef(runBacktest(REQ, { dataset: await loadDataset() }));
    const other = contentRef(runBacktest({ ...REQ, seed: 43 }, { dataset: await loadDataset() }));
    expect(other).not.toEqual(base);
  });

  it('dataset fingerprint is stable', async () => {
    expect(datasetFingerprint(await loadDataset())).toEqual(datasetFingerprint(await loadDataset()));
  });
});
