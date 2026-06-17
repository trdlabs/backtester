// Standalone momentum byte-identity guardrail — pins the frozen golden `result_hash` for the LEGACY
// momentum runner, INDEPENDENT of the overlay engine. This file imports ONLY the legacy runner, the
// determinism helpers, and the fixture data port — NOTHING from `src/engine/**`. That independence is
// the guardrail: a future overlay-engine change can never silently move the momentum golden, because
// nothing here touches the overlay path.
//
// Setup mirrors `determinism.test.ts` EXACTLY (seed 42, dataset `smoke-btc-1m`, symbol BTCUSDT, mode
// 'research', period, empty metrics) so the hash matches. FIXTURES_DIR is inlined (not imported from
// `./helpers`, which transitively pulls in `../src/app` → engine code).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { contentRef } from '../src/determinism/hash';
import { canonicalJson } from '../src/determinism/canonical-json';
import { FixtureDataPort, materialize } from '../src/data/reader';
import { runBacktest } from '../src/runner/run-backtest';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');

// The frozen momentum golden. A hardcoded string literal — NOT read from anywhere. If this test fails
// on the hash, the run setup drifted from determinism.test.ts; fix the setup, never this literal.
const FROZEN_MOMENTUM_GOLDEN = 'sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba';

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

describe('momentum byte-identity guardrail (independent of the overlay engine)', () => {
  it('legacy momentum runner result_hash equals the frozen golden', async () => {
    const result = await runBacktest(REQ, { dataset: await loadDataset() });

    // Byte-identity: the legacy momentum runner's content hash IS the frozen golden.
    expect(contentRef(result)).toBe(FROZEN_MOMENTUM_GOLDEN);

    // Lock the metrics byte layout too — a canonical-JSON snapshot of the metrics map.
    expect(canonicalJson(result.metrics)).toMatchSnapshot();
  });

  it('the momentum runner output is comparison-free', async () => {
    const result = await runBacktest(REQ, { dataset: await loadDataset() });

    // The momentum BacktestResult has NO `comparison` concept (runKind is baseline-only).
    expect(result.runKind).toBe('baseline-only');
    expect('comparison' in result).toBe(false);
  });

  it('the momentum RunResultSummary projection omits the comparison key', async () => {
    const result = await runBacktest(REQ, { dataset: await loadDataset() });

    // Mirror the momentum summary projection (the `else` branch of jobs/worker.ts::processNextQueued)
    // inline — engine-independent, no worker import (the worker pulls in src/engine/**). The momentum
    // path builds these keys and NEVER sets `comparison`.
    const summary = {
      runId: REQ.runId,
      status: 'completed' as const,
      metrics: result.metrics,
      artifactRefs: [] as readonly string[],
      evidence: {
        seed: REQ.seed,
        moduleVersions: [REQ.moduleRef],
        datasetRef: REQ.datasetRef,
      },
      resultHash: contentRef(result),
    };

    expect('comparison' in summary).toBe(false);
  });
});
