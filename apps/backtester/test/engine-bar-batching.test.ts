// Task 4 (17b bar batching) — engine batch path in `runSymbol`'s loop, driven end-to-end through
// `runBacktest` against a scripted FAKE executor (NO Docker, NO real sandbox). The fake plugs in at
// the `ModuleExecutor` seam (`router: createTrustedRouter(fakeExecutor)`), so these tests pin the
// RUNNER's cursor arithmetic, gating, and lockstep-equivalence — independent of Task 3's real
// SandboxSession.callHookBatch protocol (pinned separately in sandbox-session-batch.test.ts) and of
// Task 4's SandboxModuleExecutor.executeStrategyHookBatch fail-closed mapping (also exercised there).
import { describe, expect, it } from 'vitest';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { createTrustedRegistry } from '../src/engine/registry.js';
import { createTrustedRouter, firstDecision, type ModuleExecutor } from '../src/engine/module-executor.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import { DEFAULT_RISK, DEFAULT_EXEC } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type {
  Bar,
  HypothesisOverlayModule,
  LifecycleHook,
  OverlayDecision,
  StrategyContext,
  StrategyDecision,
  StrategyModule,
} from '@trading/research-contracts/research';

const TS0 = 1_781_740_800_000;
const BAR_MS = 60_000;

function makeCandles(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: TS0 + i * BAR_MS,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  })) as unknown as Bar[];
}

function makeDataset(symbol: string, candles: readonly Bar[]): CandleDataset {
  return {
    datasetRef: 'fake',
    timeframe: '1m',
    symbols: () => [symbol],
    candles: () => candles,
  };
}

function barIndexOf(ctx: StrategyContext): number {
  return Math.round((ctx.bar.ts - TS0) / BAR_MS);
}

/** A minimal StrategyModule double. Its own hook functions are NEVER called directly — a FAKE
 * `ModuleExecutor` intercepts every hook invocation — but `module.onPositionBar`'s mere PRESENCE
 * (a plain property check in `processBar`) gates whether the post_entry_management stage runs, so
 * tests that need an exit path must set it (even to a no-op). */
function makeModule(id: string, opts: { onPositionBar?: boolean } = {}): StrategyModule {
  const hooks: LifecycleHook[] = opts.onPositionBar ? ['onBarClose', 'onPositionBar'] : ['onBarClose'];
  const mod: Record<string, unknown> = {
    manifest: { ...shortAfterPump.manifest, id, version: '1.0.0', name: id, hooks },
    onBarClose: () => ({ kind: 'idle' }),
  };
  if (opts.onPositionBar) mod.onPositionBar = () => ({ kind: 'idle' });
  return mod as unknown as StrategyModule;
}

function makeRequest(runLabel: string, moduleId: string, symbol = 'TST', n = 5): BacktestRunRequest {
  return {
    runId: `run-${runLabel}`,
    mode: 'research',
    moduleRef: { id: moduleId, version: '1.0.0' },
    datasetRef: 'fake',
    symbols: [symbol],
    timeframe: '1m',
    period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + n * BAR_MS).toISOString() },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'default_exec', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;
}

type HookCall = { readonly hook: LifecycleHook; readonly module: StrategyModule; readonly ctx: StrategyContext };

/** Plain-object executor exposing ONLY `executeStrategyHook`/`executeOverlayApply` — no
 * `executeStrategyHookBatch` key at all (not merely `undefined`), for the "executor without the
 * batch method" gate case. */
function makeLockstepOnlyExecutor(
  onCall: (hook: LifecycleHook, ctx: StrategyContext) => readonly StrategyDecision[] = () => [{ kind: 'idle' }],
): ModuleExecutor & { hookCalls: HookCall[] } {
  const hookCalls: HookCall[] = [];
  return {
    hookCalls,
    async executeStrategyHook(module: StrategyModule, hook: LifecycleHook, ctx: StrategyContext) {
      hookCalls.push({ hook, module, ctx });
      return onCall(hook, ctx);
    },
    async executeOverlayApply(_overlay: HypothesisOverlayModule, _ctx: StrategyContext): Promise<readonly OverlayDecision[]> {
      return [];
    },
    async executeStrategyHookBarMajor(
      items: readonly { module: StrategyModule; ctx: StrategyContext }[],
    ): Promise<readonly StrategyDecision[]> {
      const out: StrategyDecision[] = [];
      for (const it of items) {
        const ds = await this.executeStrategyHook(it.module, 'onBarClose', it.ctx);
        out.push(firstDecision(ds));
      }
      return out;
    },
  };
}

interface BatchScriptEntry {
  readonly stoppedAt: number;
  readonly decisions: readonly StrategyDecision[];
}

/** Full executor: batch method present. Unscripted batch calls fall back to a full-idle sweep of
 * the whole offered ctxs window (`stoppedAt: ctxs.length - 1, decisions: []`) so flat-tail
 * continuations don't need to be hand-scripted call-by-call. */
function makeBatchExecutor(
  batchScript: readonly BatchScriptEntry[] = [],
  onLockstepCall: (hook: LifecycleHook, ctx: StrategyContext) => readonly StrategyDecision[] = () => [{ kind: 'idle' }],
): ModuleExecutor & { hookCalls: HookCall[]; batchCalls: StrategyContext[][] } {
  const hookCalls: HookCall[] = [];
  const batchCalls: StrategyContext[][] = [];
  const script = [...batchScript];
  return {
    hookCalls,
    batchCalls,
    async executeStrategyHook(module: StrategyModule, hook: LifecycleHook, ctx: StrategyContext) {
      hookCalls.push({ hook, module, ctx });
      return onLockstepCall(hook, ctx);
    },
    async executeOverlayApply(_overlay: HypothesisOverlayModule, _ctx: StrategyContext): Promise<readonly OverlayDecision[]> {
      return [];
    },
    async executeStrategyHookBatch(
      _module: StrategyModule,
      ctxs: readonly StrategyContext[],
    ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }> {
      batchCalls.push([...ctxs]);
      const next = script.shift();
      if (next !== undefined) return next;
      return { stoppedAt: ctxs.length - 1, decisions: [] };
    },
    async executeStrategyHookBarMajor(
      items: readonly { module: StrategyModule; ctx: StrategyContext }[],
    ): Promise<readonly StrategyDecision[]> {
      const out: StrategyDecision[] = [];
      for (const it of items) {
        const ds = await this.executeStrategyHook(it.module, 'onBarClose', it.ctx);
        out.push(firstDecision(ds));
      }
      return out;
    },
  };
}

function makeRegistry(module: StrategyModule) {
  return createTrustedRegistry({ strategies: [module], riskProfiles: [DEFAULT_RISK], executionProfiles: [DEFAULT_EXEC] });
}

async function run(id: string, module: StrategyModule, executor: ModuleExecutor, n: number, maxBars: number | undefined): Promise<Awaited<ReturnType<typeof runBacktest>>> {
  const candles = makeCandles(n);
  const dataset = makeDataset('TST', candles);
  const deps: RunDeps = {
    registry: makeRegistry(module),
    dataset,
    router: createTrustedRouter(executor),
    ...(maxBars !== undefined ? { barBatching: { maxBars } } : {}),
  };
  const manifestId = (module.manifest as unknown as { id: string }).id;
  return runBacktest(makeRequest(id, manifestId, 'TST', n), deps);
}

describe('17b bar batching — engine batch path (Task 4)', () => {
  describe('cursor / off-by-one', () => {
    it.each([
      [0, 'first bar'],
      [2, 'mid (2 of 5)'],
      [4, 'last bar (N-1)'],
    ])('scripted stoppedAt=%d (%s): full-tape bookkeeping stays correct', async (stoppedAt) => {
      const n = 5;
      const module = makeModule('cursor-test');
      const executor = makeBatchExecutor([{ stoppedAt, decisions: [{ kind: 'enter', side: 'long' }] }]);
      const out = await run(`cursor-${stoppedAt}`, module, executor, n, n);

      expect(out.status).toBe('completed');
      if (out.status !== 'completed') return;

      const records = out.baseline.decisionRecords;
      expect(records).toHaveLength(n);
      const barIndices = records.map((r) => r.barIndex).sort((a, b) => a - b);
      expect(barIndices).toEqual([0, 1, 2, 3, 4]);
      expect(out.baseline.evidence.equityCurve).toHaveLength(n);

      // Exactly one batch call (the whole tape offered in one shot); the tail after stoppedAt is
      // handled by lockstep (executeStrategyHook), one call per remaining bar.
      expect(executor.batchCalls).toHaveLength(1);
      expect(executor.batchCalls[0]).toHaveLength(n);
      expect(executor.hookCalls).toHaveLength(n - 1 - stoppedAt);
      // Total executor invocations == batch calls + lockstep calls (the exact call-count contract).
      expect(executor.batchCalls.length + executor.hookCalls.length).toBe(1 + (n - 1 - stoppedAt));
    });
  });

  it('gate: in-position / pending-present bars are NEVER offered to a batch call', async () => {
    const n = 10;
    const module = makeModule('gate-test', { onPositionBar: true });
    const executor = makeBatchExecutor(
      [{ stoppedAt: 1, decisions: [{ kind: 'enter', side: 'long' }] }],
      (hook, ctx) => {
        if (hook === 'onPositionBar' && barIndexOf(ctx) === 4) {
          return [{ kind: 'exit', target: 'gate-test' } as StrategyDecision];
        }
        return [{ kind: 'idle' }];
      },
    );
    const out = await run('gate', module, executor, n, n);
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;

    // Two batch calls: the initial speculative full-tape offer (pre-entry) and the post-exit tail.
    expect(executor.batchCalls).toHaveLength(2);
    expect(barIndexOf(executor.batchCalls[0][0]!)).toBe(0);
    expect(barIndexOf(executor.batchCalls[1][0]!)).toBe(5); // resumes right after the exit settles

    // Literal gate invariant: every ctx ever OFFERED to a batch call is snapshotted while the
    // portfolio was still flat (position/pendingIntent null) — batching never fires once a position
    // or pending order exists, so no batch-offered ctx can observe otherwise.
    for (const ctxs of executor.batchCalls) {
      for (const ctx of ctxs) {
        expect(ctx.position).toBeNull();
        expect(ctx.pendingIntent).toBeNull();
      }
    }

    // The in-position stretch (bars 2,3,4 — entry fills at bar2's open, exit decided at bar4) is
    // handled EXCLUSIVELY via lockstep: onBarClose + onPositionBar for each of those three bars.
    const lockstepBarIndices = [...new Set(executor.hookCalls.map((c) => barIndexOf(c.ctx)))].sort((a, b) => a - b);
    expect(lockstepBarIndices).toEqual([2, 3, 4]);
    expect(executor.hookCalls).toHaveLength(6); // 3 bars x {onBarClose, onPositionBar}
  });

  it('executor without executeStrategyHookBatch (plain lockstep-only object) ⇒ zero batch calls even with the flag on', async () => {
    const n = 5;
    const module = makeModule('no-batch-method');
    const executor = makeLockstepOnlyExecutor();
    expect('executeStrategyHookBatch' in executor).toBe(false);

    const out = await run('no-batch-method', module, executor, n, n);
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;

    expect(executor.hookCalls).toHaveLength(n);
    expect(out.baseline.decisionRecords).toHaveLength(n);
  });

  it('flag off (no barBatching in deps) ⇒ zero batch calls + lockstep call-signature unchanged', async () => {
    const n = 5;
    const module = makeModule('flag-off');
    const executor = makeBatchExecutor(); // batch method IS present...
    const out = await run('flag-off', module, executor, n, undefined); // ...but flag is absent

    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;

    expect(executor.batchCalls).toHaveLength(0);
    expect(executor.hookCalls).toHaveLength(n);
    // Byte-shape pin: lockstep still calls (module, hook, ctx) — same triple as pre-17b. No 4th
    // argument, hook is always 'onBarClose' (module declares no onPositionBar here), ctx carries the
    // full StrategyContext shape (spot-check a couple of fields the batch path also relies on).
    for (const call of executor.hookCalls) {
      expect(call.hook).toBe('onBarClose');
      expect(call.module).toBe(module);
      expect(typeof call.ctx.symbol).toBe('string');
      expect(call.ctx.bar).toBeDefined();
    }
  });

  it('error mid-batch (fail-closed shape: stoppedAt clamped, empty decisions) ⇒ run continues, lockstep-equivalent outcome', async () => {
    const n = 5;
    const module = makeModule('error-mid-batch');
    // Mirrors SandboxModuleExecutor.executeStrategyHookBatch's fail-closed mapping on a session
    // error: stoppedAt clamped into range, decisions always []. The runner must not throw or lose
    // bars — it treats this exactly like an ordinary empty-decision batch outcome.
    const executor = makeBatchExecutor([{ stoppedAt: 2, decisions: [] }]);
    const out = await run('error-mid-batch', module, executor, n, n);

    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    const records = out.baseline.decisionRecords;
    expect(records).toHaveLength(n);
    expect(records.map((r) => r.barIndex).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (const r of records) expect(r.baseDecision).toEqual({ kind: 'idle' });
    expect(out.baseline.evidence.equityCurve).toHaveLength(n);
  });

  it('maxBars < 2 ⇒ lockstep (engine guard, not just the config-layer clamp)', async () => {
    const n = 5;
    const module = makeModule('clamp-test');
    const executor = makeBatchExecutor();
    const out = await run('clamp-test', module, executor, n, 1); // maxBars: 1

    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    expect(executor.batchCalls).toHaveLength(0);
    expect(executor.hookCalls).toHaveLength(n);
  });
});
