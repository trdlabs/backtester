// Task 4 (Slice B — bar-major transport collapse) — `executeStrategyHookBarMajor` executor method.
//
// Two executors, two behaviors:
//  - SandboxModuleExecutor + universe mode: routes to the shared session's `callHookBarMajor` — ONE
//    IPC round-trip for the whole batch (the real collapse). Per-item error/invalid-schema results
//    degrade to `{ kind: 'idle' }` for THAT item only and are recorded via `executor.errors`.
//  - InProcessTrustedModuleExecutor: no batch collapse available — loops `executeStrategyHook` per
//    item, byte-identical to calling it individually.
//
// ScriptedDriver/RecordingWritable/bundle/makeCtx harness copied VERBATIM from
// sandbox-executor-universe.test.ts (same fake-driver-over-in-memory-streams pattern, no real Docker).
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleManifest, StrategyContext, StrategyDecision, StrategyModule } from '@trading/research-contracts/research';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
import { InProcessTrustedModuleExecutor } from '../src/engine/module-executor.js';
import { DockerDriver, type SpawnedContainer, type DockerRunOptions } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';

/** Captures every NDJSON line written to the fake container's stdin, parsed. */
class RecordingWritable extends Writable {
  readonly sent: unknown[] = [];
  private acc = '';
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.acc += String(chunk);
    let nl = this.acc.indexOf('\n');
    while (nl >= 0) {
      const line = this.acc.slice(0, nl);
      this.acc = this.acc.slice(nl + 1);
      if (line.length > 0) this.sent.push(JSON.parse(line));
      nl = this.acc.indexOf('\n');
    }
    cb();
  }
}

/**
 * A DockerDriver whose spawnSession hands back fully in-memory streams (no `docker` binary, no real
 * container). Tracks how many times spawnSession is actually invoked — the universe invariant this
 * task relies on is exactly ONE spawn for N symbols.
 */
class ScriptedDriver extends DockerDriver {
  readonly stdin = new RecordingWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  spawnCount = 0;
  lastName: string | undefined;
  disposeCount = 0;

  get sent(): unknown[] {
    return this.stdin.sent;
  }

  override spawnSession(_policy: unknown, opts: DockerRunOptions): SpawnedContainer {
    this.spawnCount += 1;
    this.lastName = opts.name;
    return {
      name: opts.name,
      child: { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr } as unknown as ChildProcessWithoutNullStreams,
    };
  }

  override inspectState(): { oomKilled: boolean; exitCode: number; running: boolean } | undefined {
    return undefined;
  }

  override dispose(): void {
    this.disposeCount += 1;
  }
}

const BUNDLE_HASH = `sha256:${'ef'.repeat(32)}`;

const bundle: ModuleBundle = {
  bundleDir: '/nonexistent/test-strategy-bundle',
  manifest: { id: 'test_strategy', version: '1.0.0', kind: 'strategy', hooks: ['onBarClose'] } as unknown as ModuleManifest,
  descriptor: {
    contractVersion: '1.0.0',
    kind: 'strategy',
    entryPoint: 'module/index.js',
    files: [],
    bundleHash: BUNDLE_HASH,
  },
};

const dummyModule = {} as unknown as StrategyModule;

/** Minimal StrategyContext double for a given symbol/bar timestamp. */
function makeCtx(symbol: string, ts: number): StrategyContext {
  return {
    run: { runId: 'run-exec-bar-major-1', mode: 'backtest', seed: 1 },
    params: {},
    symbol,
    bar: { ts, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    position: null,
    pendingIntent: null,
    portfolio: { equity: 1000, openPositions: 0 },
    clock: { now: () => ts },
    data: {},
    indicators: {},
    rng: { next: () => 0.5 },
  } as unknown as StrategyContext;
}

/** Write a scripted `{t:'ok', decisions:[]}` response line — used for the per-symbol lazy `init`
 * handshakes that `callHookBarMajor` sends before its `hookBarMajor` envelope. */
function writeOk(driver: ScriptedDriver): void {
  driver.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
}

/** Write a scripted tagged `okBarMajor` response line covering the whole batch. */
function writeBarMajorOk(
  driver: ScriptedDriver,
  results: readonly (
    | { readonly ok: true; readonly decisions: readonly unknown[] }
    | { readonly ok: false; readonly error: { readonly code: string; readonly detail: string } }
  )[],
): void {
  driver.stdout.write(`${JSON.stringify({ t: 'okBarMajor', seq: 1, results })}\n`);
}

/** Reference reduction under test: "first decision or idle" — matches `runner.ts`'s `firstDecision`. */
function firstOf(decisions: readonly StrategyDecision[]): StrategyDecision {
  return decisions.length > 0 ? decisions[0]! : { kind: 'idle' };
}

describe('SandboxModuleExecutor.executeStrategyHookBarMajor', () => {
  it('universe mode: sends ONE hookBarMajor for the whole batch; a per-symbol error is recorded and degrades that item to idle', async () => {
    const driver = new ScriptedDriver();
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, {
      driver,
      harnessDir: '/fake/harness/dir',
      universe: { enabled: true, n: 2, memBaseMb: 128, memPerSymbolMb: 32 },
    });

    const items = [
      { module: dummyModule, ctx: makeCtx('AAA', 0) },
      { module: dummyModule, ctx: makeCtx('BBB', 0) },
    ];

    const p = executor.executeStrategyHookBarMajor(items);
    writeOk(driver); // reply to lazy init(AAA)
    writeOk(driver); // reply to lazy init(BBB)
    writeBarMajorOk(driver, [
      { ok: true, decisions: [{ kind: 'enter', side: 'long' }] },
      { ok: false, error: { code: 'sandbox_crashed', detail: 'strategy threw' } },
    ]);
    const bases = await p;

    // index-aligned with `items`: AAA's real decision, BBB's fail-closed idle base.
    expect(bases).toHaveLength(2);
    expect(bases[0]).toEqual({ kind: 'enter', side: 'long' });
    expect(bases[1]).toEqual({ kind: 'idle' });

    // exactly ONE hookBarMajor envelope carrying both symbols — the collapse this task routes to.
    const envelopes = driver.sent.filter((m) => (m as { t?: string }).t === 'hookBarMajor');
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0] as { bars: unknown[] }).bars).toHaveLength(2);

    // BBB's error is recorded and attributed to it specifically.
    expect(executor.errors).toHaveLength(1);
    expect(executor.errors[0]?.symbol).toBe('BBB');
    expect(executor.errors[0]?.code).toBe('sandbox_crashed');

    // ONE spawn for 2 symbols — universe collapse, not per-symbol sessions.
    expect(driver.spawnCount).toBe(1);
  });

  it('non-universe mode: no batch collapse possible (per-symbol sessions) — falls back to a lockstep loop', async () => {
    const driver = new ScriptedDriver();
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, {
      driver,
      harnessDir: '/fake/harness/dir',
      // deps.universe intentionally undefined.
    });

    const items = [
      { module: dummyModule, ctx: makeCtx('AAA', 0) },
      { module: dummyModule, ctx: makeCtx('BBB', 0) },
    ];

    // Non-universe: each item gets its OWN session (own container spawn) sharing this ScriptedDriver's
    // single in-memory stdout stream; the loop `await`s item i's `open()` + hook in full before
    // starting item i+1. Because both sessions' IPC channels attach listeners to the SAME stream, BBB's
    // replies must not be written until BBB's session has actually spawned (`vi.waitFor` on
    // `spawnCount`) — otherwise they'd be delivered only to AAA's still-attached listener and lost.
    const p = executor.executeStrategyHookBarMajor(items);
    writeOk(driver); // reply to open()'s eager init send for AAA's (new) session
    writeOk(driver); // reply to hook(AAA, bar0)
    await vi.waitFor(() => expect(driver.spawnCount).toBe(2));
    writeOk(driver); // reply to open()'s eager init send for BBB's (new) session
    writeOk(driver); // reply to hook(BBB, bar0)
    const bases = await p;

    expect(bases).toEqual([{ kind: 'idle' }, { kind: 'idle' }]);
    // no hookBarMajor envelope was ever sent — the non-universe path never batches.
    expect(driver.sent.some((m) => (m as { t?: string }).t === 'hookBarMajor')).toBe(false);
    // one session (one spawn) PER symbol — the pre-existing, non-collapsed behavior.
    expect(driver.spawnCount).toBe(2);
  });
});

describe('InProcessTrustedModuleExecutor.executeStrategyHookBarMajor', () => {
  it('loops executeStrategyHook per item — byte-identical bases, no batching', async () => {
    const executor = new InProcessTrustedModuleExecutor();
    let calls = 0;
    const module: StrategyModule = {
      onBarClose: (ctx: StrategyContext) => {
        calls += 1;
        return ctx.symbol === 'AAA' ? { kind: 'enter', side: 'long' } : { kind: 'idle' };
      },
    } as unknown as StrategyModule;

    const ctxA = makeCtx('AAA', 0);
    const ctxB = makeCtx('BBB', 0);

    calls = 0;
    const looped = [
      firstOf(await executor.executeStrategyHook(module, 'onBarClose', ctxA)),
      firstOf(await executor.executeStrategyHook(module, 'onBarClose', ctxB)),
    ];
    const loopedCalls = calls;

    calls = 0;
    const bases = await executor.executeStrategyHookBarMajor([
      { module, ctx: ctxA },
      { module, ctx: ctxB },
    ]);

    expect(bases).toEqual(looped);
    expect(bases).toEqual([{ kind: 'enter', side: 'long' }, { kind: 'idle' }]);
    expect(calls).toBe(loopedCalls); // same number of onBarClose invocations as the manual loop
    expect(calls).toBe(2);
  });

  it('empty items ⇒ empty bases, on both executors', async () => {
    const trusted = new InProcessTrustedModuleExecutor();
    expect(await trusted.executeStrategyHookBarMajor([])).toEqual([]);

    const driver = new ScriptedDriver();
    const sandbox = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, { driver, harnessDir: '/fake/harness/dir' });
    expect(await sandbox.executeStrategyHookBarMajor([])).toEqual([]);
    expect(driver.spawnCount).toBe(0); // no session ever touched for an empty batch
  });
});
