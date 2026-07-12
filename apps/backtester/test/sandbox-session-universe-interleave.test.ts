// Task 8 (bar-major interleave) — proves the universe SandboxSession's per-symbol bookkeeping
// (buildHookPayload's `this.perSymbol` map, keyed by ctx.symbol — see sandbox-session.ts) is correct
// when driven in the INTERLEAVED order bar-major execution produces (`A@bar0, B@bar0, A@bar1,
// B@bar1, …`) rather than the symbol-major order (`A0, A1, …, B0, B1`) every other universe test in
// this suite exercises. This is a low-level TRACE assertion (per-envelope symbol + barIndex), not
// just a final-hash check — it would catch a shared/global cursor bug that a hash comparison could
// miss if the corruption happened to cancel out.
//
// Fake driver/channel/ctx helpers copied verbatim from sandbox-session-universe.test.ts (see that
// file's header comment for the ScriptedDriver/RecordingWritable/AsyncIpcChannel rationale).
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest, StrategyContext } from '@trading/research-contracts/research';
import { SandboxSession, type SessionConfig } from '../src/engine/sandbox/sandbox-session.js';
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

/** A DockerDriver whose spawnSession hands back fully in-memory streams — no `docker` binary. */
class ScriptedDriver extends DockerDriver {
  readonly stdin = new RecordingWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  spawnCount = 0;

  get sent(): unknown[] {
    return this.stdin.sent;
  }

  override spawnSession(_policy: unknown, opts: DockerRunOptions): SpawnedContainer {
    this.spawnCount += 1;
    return {
      name: opts.name,
      child: { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr } as unknown as ChildProcessWithoutNullStreams,
    };
  }

  override inspectState(): { oomKilled: boolean; exitCode: number; running: boolean } | undefined {
    return undefined;
  }

  override dispose(): void {
    // no-op: this suite doesn't exercise teardown
  }
}

const bundle: ModuleBundle = {
  bundleDir: '/nonexistent/test-strategy-bundle',
  manifest: { id: 'test_strategy', version: '1.0.0', kind: 'strategy', hooks: ['onBarClose'] } as unknown as ModuleManifest,
  descriptor: {
    contractVersion: '1.0.0',
    kind: 'strategy',
    entryPoint: 'module/index.js',
    files: [],
    bundleHash: 'sha256:0',
  },
};

const BUNDLE_HASH = `sha256:${'ab'.repeat(32)}`;

function newUniverseSession(): { session: SandboxSession; driver: ScriptedDriver } {
  const driver = new ScriptedDriver();
  const cfg: SessionConfig = {
    runId: 'run-uni-interleave-1',
    symbol: 'UNUSED', // unused for container naming in universe mode; kept for the (required) field
    seed: 1,
    params: {},
    kind: 'strategy',
    universe: true,
    bundleHash: BUNDLE_HASH,
  };
  const session = new SandboxSession(bundle, DEFAULT_SANDBOX, cfg, driver, '/fake/harness/dir');
  return { session, driver };
}

/** Minimal StrategyContext double for a given symbol/bar timestamp. */
function makeCtx(symbol: string, ts: number): StrategyContext {
  return {
    run: { runId: 'run-uni-interleave-1', mode: 'backtest', seed: 1 },
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

const BAR_MS = 60_000;

describe('SandboxSession universe mode — bar-major interleaved call order', () => {
  it('keeps per-symbol hook order + monotonic per-symbol barIndex under A0,B0,A1,B1 interleave', async () => {
    const { session, driver } = newUniverseSession();

    // A@bar0 — lazy init(A) + hook(A, bar0).
    const pA0 = session.callHook('onBarClose', makeCtx('A', 0));
    writeOk(driver); // init(A)
    writeOk(driver); // hook(A, bar0)
    const rA0 = await pA0;
    expect(rA0.ok).toBe(true);

    // B@bar0 — lazy init(B) + hook(B, bar0), same (already-open) container.
    const pB0 = session.callHook('onBarClose', makeCtx('B', 0));
    writeOk(driver); // init(B)
    writeOk(driver); // hook(B, bar0)
    const rB0 = await pB0;
    expect(rB0.ok).toBe(true);

    // A@bar1 — A already initialized, no init envelope this time.
    const pA1 = session.callHook('onBarClose', makeCtx('A', BAR_MS));
    writeOk(driver); // hook(A, bar1)
    const rA1 = await pA1;
    expect(rA1.ok).toBe(true);

    // B@bar1 — B already initialized, no init envelope this time.
    const pB1 = session.callHook('onBarClose', makeCtx('B', BAR_MS));
    writeOk(driver); // hook(B, bar1)
    const rB1 = await pB1;
    expect(rB1.ok).toBe(true);

    // Exactly ONE container, ONE init per symbol (2 total), regardless of interleave.
    expect(driver.spawnCount).toBe(1);
    const inits = driver.sent.filter((m) => (m as { t?: string }).t === 'init');
    expect(inits).toHaveLength(2);

    const hooks = driver.sent.filter(
      (m): m is { t: string; snapshot: { symbol: string; barIndex: number }; newBar: unknown } =>
        (m as { t?: string }).t === 'hook',
    );
    expect(hooks).toHaveLength(4);

    // 1. The hook-call order is exactly the bar-major interleave: A@0, B@0, A@1, B@1.
    const sentHookSymbols = hooks.map((h) => h.snapshot.symbol);
    expect(sentHookSymbols).toEqual(['A', 'B', 'A', 'B']);

    // 2. Each symbol's per-bar bookkeeping (barIndex the session sent for that symbol) is monotonic
    // PER SYMBOL, and matches what it would see driven symbol-major — proving buildHookPayload's
    // per-symbol map slot (sandbox-session.ts `this.perSymbol`, keyed by ctx.symbol) isn't corrupted
    // by a shared/global cursor when calls interleave across symbols.
    const barIndexBySymbol = new Map<string, number[]>();
    for (const h of hooks) {
      const arr = barIndexBySymbol.get(h.snapshot.symbol) ?? [];
      arr.push(h.snapshot.barIndex);
      barIndexBySymbol.set(h.snapshot.symbol, arr);
    }
    expect(barIndexBySymbol.get('A')).toEqual([0, 1]);
    expect(barIndexBySymbol.get('B')).toEqual([0, 1]);

    // 3. NON-VACUOUS interleave check: every one of the 4 hooks carries a real (non-null) `newBar`.
    // Both symbols share the SAME bar timestamp per logical bar (ts=0 for bar0, ts=BAR_MS for bar1),
    // so `barIndex` alone is IDENTICAL under a correct per-symbol implementation and under a
    // hypothetical shared-scalar (cross-symbol) `lastBarTs` bug — both would produce A->[0,1],
    // B->[0,1]. `newBar` is what actually diverges: buildHookPayload only stamps a real `newBar`
    // when `ctx.bar.ts !== st.lastBarTs` for THAT symbol's bookkeeping slot. Under a shared-scalar
    // bug, B@bar0 (and B@bar1) would see `lastBarTs` already stamped by A's just-prior call at the
    // same ts and get `newBar === null` — a false "no new bar" for B's own first bar. Correct
    // per-symbol bookkeeping (`this.perSymbol` keyed by ctx.symbol) sends a real newBar for every
    // symbol's own bar, regardless of what any other symbol just did.
    for (const h of hooks) {
      expect(h.newBar).not.toBeNull();
    }
  });
});
