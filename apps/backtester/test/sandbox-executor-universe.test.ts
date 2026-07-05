// Task 7 (universe-session) — SandboxModuleExecutor universe mode: ONE shared session (keyed by a
// constant, not ctx.symbol) serves N symbols; per-symbol errors stay attributed via `record()`'s
// existing `ctx.symbol` tagging (unchanged), and a soft per-symbol harness `err` degrades only that
// symbol — the run keeps going for the rest. Flag off (`deps.universe` undefined) stays
// byte-identical to pre-Task-7 behavior: one session (one container spawn) PER symbol.
//
// Fake-driver pattern copied verbatim from sandbox-session-universe.test.ts (ScriptedDriver +
// RecordingWritable capturing NDJSON stdin lines) — no real Docker involved.
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest, StrategyContext, StrategyModule } from '@trading/research-contracts/research';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
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
 * task pins is exactly ONE spawn for N symbols (vs. N spawns when `deps.universe` is undefined).
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

const BUNDLE_HASH = `sha256:${'cd'.repeat(32)}`;

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
    run: { runId: 'run-exec-uni-1', mode: 'backtest', seed: 1 },
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

/** Write a scripted `{t:'ok', decisions:[]}` response line to the fake container's stdout. */
function writeOk(driver: ScriptedDriver): void {
  driver.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
}

/** Write a scripted `{t:'err', ...}` response line — harness-caught exception, container alive. */
function writeErr(driver: ScriptedDriver, detail = 'strategy threw'): void {
  driver.stdout.write(`${JSON.stringify({ t: 'err', code: 'sandbox_crashed', detail, hook: 'onBarClose' })}\n`);
}

describe('SandboxModuleExecutor universe mode', () => {
  it('uses ONE session (one spawn) across all symbols; records per-symbol errors', async () => {
    const driver = new ScriptedDriver();
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, {
      driver,
      harnessDir: '/fake/harness/dir',
      universe: { enabled: true, n: 3, memBaseMb: 128, memPerSymbolMb: 32 },
    });

    const symbols = ['AAA', 'BBB', 'CCC'];

    // symbol[0] (AAA): initStrategy just opens the (first) shared session — one spawn, no reply
    // needed (manifest.hooks has no 'init'). Then the first onBarClose lazily inits AAA + runs it.
    await executor.initStrategy(dummyModule, makeCtx(symbols[0]!, 0));
    const p0 = executor.executeStrategyHook(dummyModule, 'onBarClose', makeCtx(symbols[0]!, 0));
    writeOk(driver); // reply to lazy init(AAA)
    writeOk(driver); // reply to hook(AAA, bar0)
    const d0 = await p0;
    expect(d0).toEqual([]);

    // symbol[1] (BBB): same shared session (already open) — initStrategy is a no-op re: spawning.
    // Scripted err on BBB's hook call: a harness-caught exception, degrading ONLY BBB.
    await executor.initStrategy(dummyModule, makeCtx(symbols[1]!, 0));
    const p1 = executor.executeStrategyHook(dummyModule, 'onBarClose', makeCtx(symbols[1]!, 0));
    writeOk(driver); // reply to lazy init(BBB)
    writeErr(driver); // reply to hook(BBB, bar0) — soft per-symbol failure
    const d1 = await p1;
    expect(d1).toEqual([]); // fail-closed: empty decisions

    // symbol[2] (CCC): same shared session, unaffected by BBB's failure — the run keeps going.
    await executor.initStrategy(dummyModule, makeCtx(symbols[2]!, 0));
    const p2 = executor.executeStrategyHook(dummyModule, 'onBarClose', makeCtx(symbols[2]!, 0));
    writeOk(driver); // reply to lazy init(CCC)
    writeOk(driver); // reply to hook(CCC, bar0)
    const d2 = await p2;
    expect(d2).toEqual([]);

    // ONE spawn total for 3 symbols — the universe invariant.
    expect(driver.spawnCount).toBe(1);

    // BBB's error is attributed to symbols[1] — record() already tags errors by ctx.symbol.
    expect(executor.errors).toHaveLength(1);
    expect(executor.errors[0]?.symbol).toBe(symbols[1]);
    expect(executor.errors[0]?.code).toBe('sandbox_crashed');
  });

  it('flag off ⇒ one session per symbol (today’s behavior)', async () => {
    const driver = new ScriptedDriver();
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, {
      driver,
      harnessDir: '/fake/harness/dir',
      // deps.universe intentionally undefined — byte-identical baseline.
    });

    const symbols = ['AAA', 'BBB', 'CCC'];
    for (const symbol of symbols) {
      const initP = executor.initStrategy(dummyModule, makeCtx(symbol, 0));
      writeOk(driver); // reply to init(symbol) — sent eagerly inside open() (non-universe)
      await initP;
      const hookP = executor.executeStrategyHook(dummyModule, 'onBarClose', makeCtx(symbol, 0));
      writeOk(driver); // reply to hook(symbol, bar0)
      const d = await hookP;
      expect(d).toEqual([]);
    }

    // 3 spawns for 3 symbols — no universe collapse, exactly today's per-symbol session behavior.
    expect(driver.spawnCount).toBe(3);
    expect(executor.errors).toHaveLength(0);
  });
});
