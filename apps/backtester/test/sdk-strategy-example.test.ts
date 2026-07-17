// Docker-gated: proves the SDK worked strategy example (STRATEGY_EXAMPLE_BUNDLE) is entry-convention
// compatible end-to-end through the REAL 019 sandbox executor. It materializes the SDK bundle, boots a
// session container, and drives its lifecycle hooks (`onBarClose` → enter, `onPositionBar` → exit) over
// NDJSON IPC — the same path the platform uses for untrusted strategy bundles. Skips (does not fail)
// where no Docker daemon is reachable — mirrors overlay-sandbox-session.test.ts gating.
//
// Why drive the executor directly (not the worker/run pipeline): the worker's momentum path uses the
// legacy `signals()` harness; the strategy lifecycle convention (`export default createStrategyModule`)
// only executes through the 019 SandboxModuleExecutor. See packages/sdk/README "Strategy authoring".

import { afterAll, describe, expect, it } from 'vitest';
import type {
  Bar,
  PositionSnapshot,
  StrategyContext,
  StrategyModule,
} from '@trading/research-contracts/research';
import { STRATEGY_EXAMPLE_BUNDLE } from '@trdlabs/backtester-sdk/builder';
import { loadConfig } from '../src/config.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { materializeBundle, type MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { createInertStrategyModule } from '../src/engine/sandbox/routing.js';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const SYMBOL = 'BTCUSDT';
const RUN_ID = 'sdk-strategy-example';
const BASE_TS = 1_700_000_000_000;

// rsiMax is pinned to 100 (its mathematical ceiling): a flat warmup followed by a single up-bar makes
// the REAL sandbox RSI engine return 100, which the example's default rsiMax (70) would reject. This
// test proves the entry-convention round-trip, not RSI tuning — so the gate is made deterministic.
const PARAMS = {
  lookback: 20,
  breakoutPct: 5,
  rsiPeriod: 14,
  rsiMax: 100,
  takePct: 10,
  stopPct: 5,
  dcaDrawdownPct: 3,
} as const;

function bar(i: number, close: number): Bar {
  return { ts: BASE_TS + i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 2000 };
}

// Host-side StrategyContext. The 019 harness rehydrates data/indicators/rng from the serialized
// snapshot + accumulated newBar buffer, so those host-side stubs are never serialized — only run,
// params, symbol, bar, position, pendingIntent, portfolio, clock.now() cross the boundary.
function ctx(b: Bar, position: PositionSnapshot | null): StrategyContext {
  return {
    run: { runId: RUN_ID, mode: 'research', seed: 42 },
    params: PARAMS,
    symbol: SYMBOL,
    bar: b,
    position,
    pendingIntent: null,
    portfolio: { equity: 1000, openPositions: position ? 1 : 0 },
    clock: { now: () => b.ts },
    data: { closedCandles: () => [], indicatorAsOf: () => undefined },
    indicators: { value: () => undefined, query: () => undefined },
    rng: { next: () => 0 },
  };
}

describe.skipIf(!DOCKER_AVAILABLE)('SDK worked strategy example (019 sandbox)', () => {
  let materialized: MaterializedBundle | undefined;
  let executor: SandboxModuleExecutor | undefined;

  afterAll(async () => {
    executor?.close();
    await materialized?.cleanup();
  });

  it(
    'runs STRATEGY_EXAMPLE_BUNDLE lifecycle hooks in a real container: enter on breakout, exit on take',
    async () => {
      const config = loadConfig();
      materialized = await materializeBundle(STRATEGY_EXAMPLE_BUNDLE);
      const bundle = loadBundle(materialized.bundleDir);
      executor = new SandboxModuleExecutor(bundle, config.overlaySandbox.policy, {
        harnessDir: config.overlaySandbox.harnessDir,
        containerSuffix: `sdk-ex-${process.pid}`,
      });
      const inert: StrategyModule = createInertStrategyModule(bundle.manifest);

      // Open the container + instantiate the module (no `init` hook declared — open only).
      await executor.initStrategy(inert, ctx(bar(0, 100), null));

      // Feed 21 flat warmup bars (close=100). closedCandles(20) only reaches 20 entries on the 21st
      // bar (t=20), so bars 0..19 idle (history < lookback); bar 20 breaks out 6% (>= breakoutPct).
      for (let i = 0; i < 20; i += 1) {
        const decisions = await executor.executeStrategyHook(inert, 'onBarClose', ctx(bar(i, 100), null));
        expect(decisions).toEqual([{ kind: 'idle' }]);
      }
      // Breakout bar: close 106 vs history[0]=100 → +6% >= 5% → enter long (deterministic, Task 4).
      const entry = await executor.executeStrategyHook(inert, 'onBarClose', ctx(bar(20, 106), null));
      expect(entry.length).toBe(1);
      expect(entry[0]).toMatchObject({ kind: 'enter', side: 'long' });

      // In-position: close 130 vs entryPrice 100 → +30% >= takePct(10) → exit all (deterministic).
      const position: PositionSnapshot = { side: 'long', size: 1, entryPrice: 100 };
      const exit = await executor.executeStrategyHook(inert, 'onPositionBar', ctx(bar(21, 130), position));
      expect(exit.length).toBe(1);
      expect(exit[0]).toMatchObject({ kind: 'exit', target: 'all' });

      // Clean sandbox run: container booted, IPC round-tripped, every decision revalidated — no errors.
      expect(executor.errors).toEqual([]);
    },
    60_000, // real container boot + 22 synchronous NDJSON IPC round-trips
  );
});
