import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { runBoundedPool } from '../src/jobs/pool.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { createTrustedRouter, firstDecision, type ModuleExecutor } from '../src/engine/module-executor.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';

const REQ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/overlay/requests');
const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ_DIR, n), 'utf8')) as BacktestRunRequest;

const N = 4;

// Barrier: the first hook of each run blocks until N runs are concurrently blocked, then all release.
function makeBarrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= n) release();
      await gate;
    },
  };
}

describe('async overlap — runs interleave through the pool', () => {
  it('N sandboxed-shaped runs overlap (barrier reaches N)', async () => {
    const req = loadRequest('variant.json');
    const registry = buildTrustedRegistry();
    const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
      datasetRef: req.datasetRef,
      symbols: req.symbols,
      timeframe: req.timeframe,
      period: req.period,
    });

    const barrier = makeBarrier(N);
    // One barrier executor instance per run, so the `gated` flag gates exactly once per run
    // (on its first strategy hook) — each run parks at the barrier until all N have arrived.
    const mkExec = (): ModuleExecutor => {
      let gated = false;
      return {
        async executeStrategyHook() { if (!gated) { gated = true; await barrier.wait(); } return []; },
        async executeOverlayApply() { return []; },
        async executeStrategyHookBarMajor(items) {
          const out = [];
          for (const it of items) {
            const ds = await this.executeStrategyHook(it.module, 'onBarClose', it.ctx);
            out.push(firstDecision(ds));
          }
          return out;
        },
        async initStrategy() {},
        async disposeStrategy() {},
        close() {},
      };
    };

    let issued = 0;
    const next = async (): Promise<boolean> => {
      if (issued >= N) return false;
      issued += 1;
      const out = await runOverlayBacktest(req, {
        registry,
        marketTape,
        router: createTrustedRouter(mkExec()),
      });
      expect(out.status).toBe('completed');
      return true;
    };

    // concurrency = N. If runs serialized, barrier.wait() in run #1 would block forever (arrived=1<N)
    // and this would hit the test timeout. Overlap → arrived reaches N → all release → resolves fast.
    const processed = await runBoundedPool(N, next);
    expect(processed).toBe(N);
  }, 10_000);
});
