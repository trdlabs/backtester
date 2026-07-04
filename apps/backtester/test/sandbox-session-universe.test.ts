// Task 5 (universe-session) — SandboxSession universe mode: ONE container hosts N symbols, each
// symbol gets its own `init` envelope (sent lazily on its first hook call, not inside open()), and
// per-symbol bar bookkeeping (barIndex/lastBarTs) is keyed by symbol rather than shared scalars.
//
// Fake driver/channel pattern copied from sandbox-session-batch.test.ts (ScriptedDriver + a
// RecordingWritable capturing every NDJSON line written to the fake container's stdin) — no real
// Docker involved. AsyncIpcChannel.receive() pulls one line at a time off an accumulator buffer
// (see async-ipc-channel.ts), so scripting several response lines up front (before awaiting the
// SandboxSession call that will consume them one by one) is safe — the exact technique the batch
// test's `scriptOpen` helper already relies on.
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

/**
 * A DockerDriver whose spawnSession hands back fully in-memory streams (no `docker` binary, no real
 * container). Tracks how many times spawnSession is actually invoked (the universe invariant this
 * task pins is exactly ONE spawn for N symbols) and the name it was spawned with.
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
    runId: 'run-uni-1',
    symbol: 'AAA', // unused for container naming in universe mode; kept for the (required) field
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
    run: { runId: 'run-uni-1', mode: 'backtest', seed: 1 },
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

/**
 * Write a scripted `{t:'err', ...}` response line — the harness caught a strategy exception, the
 * CONTAINER stays alive (this is the "soft" per-symbol failure this task fail-closes on, as
 * distinct from an `eof`/`timeout`/`overflow`/`malformed` channel/container death).
 */
function writeErr(driver: ScriptedDriver, detail = 'strategy threw'): void {
  driver.stdout.write(`${JSON.stringify({ t: 'err', code: 'sandbox_crashed', detail, hook: 'onBarClose' })}\n`);
}

describe('SandboxSession universe mode', () => {
  it('spawns exactly ONE container for N symbols and sends one init per symbol', async () => {
    const { session, driver } = newUniverseSession();

    // initStrategy(AAA) [lazy, inside callHook] → callHook(onBarClose, AAA bar0)
    const p1 = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to hook(AAA, bar0)
    const r1 = await p1;
    expect(r1.ok).toBe(true);

    // initStrategy(BBB) [lazy] → callHook(onBarClose, BBB bar0) — same (already-open) container.
    const p2 = session.callHook('onBarClose', makeCtx('BBB', 0));
    writeOk(driver); // reply to init(BBB)
    writeOk(driver); // reply to hook(BBB, bar0)
    const r2 = await p2;
    expect(r2.ok).toBe(true);

    expect(driver.spawnCount).toBe(1);
    expect(driver.lastName).toBeDefined();
    expect(driver.lastName).toContain('strategy');
    expect(driver.lastName).toContain(BUNDLE_HASH.replace(/^sha256:/, '').slice(0, 8));

    const inits = driver.sent.filter((m): m is { t: string; symbol: string } => (m as { t?: string }).t === 'init');
    expect(inits).toHaveLength(2);
    expect(inits[0]?.symbol).toBe('AAA');
    expect(inits[1]?.symbol).toBe('BBB');

    const hooks = driver.sent.filter((m): m is { t: string } => (m as { t?: string }).t === 'hook');
    expect(hooks).toHaveLength(2);
  });

  it('keeps per-symbol barIndex (AAA bar0 and BBB bar0 both serialize barIndex 0)', async () => {
    const { session, driver } = newUniverseSession();

    const p1 = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // init(AAA)
    writeOk(driver); // hook(AAA, bar0)
    await p1;

    const p2 = session.callHook('onBarClose', makeCtx('BBB', 0));
    writeOk(driver); // init(BBB)
    writeOk(driver); // hook(BBB, bar0)
    await p2;

    // AAA's second bar advances ITS OWN barIndex to 1, independent of BBB.
    const p3 = session.callHook('onBarClose', makeCtx('AAA', 60_000));
    writeOk(driver); // hook(AAA, bar1) — AAA already initialized, no init envelope this time
    await p3;

    const hookEntries = driver.sent.filter(
      (m): m is { t: string; snapshot: { barIndex: number } } => (m as { t?: string }).t === 'hook',
    );
    expect(hookEntries).toHaveLength(3);
    expect(hookEntries[0]?.snapshot.barIndex).toBe(0); // AAA bar0
    expect(hookEntries[1]?.snapshot.barIndex).toBe(0); // BBB bar0 — NOT shared/global with AAA
    expect(hookEntries[2]?.snapshot.barIndex).toBe(1); // AAA bar1 — AAA's own counter advanced

    // Exactly one init per symbol overall (no re-init on AAA's second call).
    const inits = driver.sent.filter((m) => (m as { t?: string }).t === 'init');
    expect(inits).toHaveLength(2);
  });

  // Review fix: callHookBatch's eager-build/rewind bookkeeping (bookkeepingAfter snapshot +
  // partial-stop restore) must target the SAME per-symbol slot buildHookPayload advances in
  // universe mode — not the frozen this.barIndex/this.lastBarTs scalars. A batch is single-symbol
  // (the executor keys it by ctxs[0].symbol), so this drives a 3-bar universe batch for ONE symbol
  // with an okBatch mid-stop (stoppedAt=1, a non-empty decision on bar1) and asserts the rewind
  // lands in AAA's map slot at barIndex 1 (not the initial -1, not advanced through bar2's build).
  it('callHookBatch okBatch partial-stop rewinds the PER-SYMBOL map slot (universe mode), not the scalars', async () => {
    const { session, driver } = newUniverseSession();

    const ctxs = [0, 1, 2].map((i) => makeCtx('AAA', i * 60_000));
    const batchPromise = session.callHookBatch(ctxs);
    writeOk(driver); // reply to lazy init(AAA)
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 1, decisions: ['SIGNAL'] })}\n`);
    const result = await batchPromise;

    expect(result).toEqual({ ok: true, stoppedAt: 1, decisions: ['SIGNAL'] });

    // Discriminator: under the PRE-FIX bug, bookkeepingAfter snapshots the frozen scalars (always
    // {barIndex:-1, lastBarTs:undefined} in universe mode, since buildHookPayload never writes the
    // scalars there) and the restore below writes into those scalars too — so AAA's REAL map slot
    // is left un-rewound, stuck at barIndex 2 (from the eager build of entry 2) with
    // lastBarTs=2*60_000. The next call below, for ctxs[2] (ts=2*60_000), would then see
    // ctx.bar.ts === st.lastBarTs and emit newBar: null (silently dropping bar2 — the harness would
    // never learn about it). Post-fix, the restore rewinds AAA's map slot to "state after entry 1"
    // (barIndex 1, lastBarTs=60_000), so the next call sees a ts mismatch and correctly re-emits
    // bar2's newBar. This is NOT a vacuous assertion — it fails under the pre-fix scalar-only
    // bookkeeping and passes only once the rewind targets the per-symbol map slot.
    const nextPromise = session.callHook('onBarClose', ctxs[2]!);
    driver.stdout.write(`${JSON.stringify({ t: 'ok', seq: 2, decisions: [] })}\n`);
    await nextPromise;

    const hookEntries = driver.sent.filter(
      (m): m is { t: string; newBar: { ts: number } | null; snapshot: { barIndex: number } } =>
        (m as { t?: string }).t === 'hook',
    );
    const lastHook = hookEntries[hookEntries.length - 1]!;
    expect(lastHook.newBar).toEqual({ ts: 2 * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(lastHook.snapshot.barIndex).toBe(2);
  });

  // Task 6 — per-symbol fail-closed. A harness `err` (the sandboxed strategy threw; the harness
  // caught it and the container is still alive) must degrade ONLY the offending symbol, not the
  // whole (shared) universe session — other symbols keep running on the same container.
  it('a harness err for symbol AAA fails-closed AAA only — the container stays up and BBB still runs', async () => {
    const { session, driver } = newUniverseSession();

    const p1 = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // reply to init(AAA)
    writeErr(driver); // reply to hook(AAA, bar0) — harness-caught exception, container alive
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    expect(r1.decisions).toEqual([]);
    expect(r1.error?.code).toBe('sandbox_crashed');
    expect(driver.disposeCount).toBe(0); // container NOT torn down

    const p2 = session.callHook('onBarClose', makeCtx('BBB', 0));
    writeOk(driver); // reply to init(BBB)
    writeOk(driver); // reply to hook(BBB, bar0)
    const r2 = await p2;
    expect(r2.ok).toBe(true); // BBB unaffected by AAA's failure

    expect(driver.spawnCount).toBe(1); // still ONE container for both symbols
    expect(driver.disposeCount).toBe(0);
  });

  it('a failed symbol stays fail-closed for its REMAINING bars without further harness calls', async () => {
    const { session, driver } = newUniverseSession();

    const p1 = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // reply to init(AAA)
    writeErr(driver); // reply to hook(AAA, bar0) → soft err, latches AAA only
    const r1 = await p1;
    expect(r1.ok).toBe(false);

    const hooksAfterFirstErr = driver.sent.filter((m) => (m as { t?: string }).t === 'hook').length;
    expect(hooksAfterFirstErr).toBe(1);

    // AAA's remaining bars must fail-closed IMMEDIATELY, without any new envelope sent to the harness.
    const r2 = await session.callHook('onBarClose', makeCtx('AAA', 60_000));
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe('sandbox_crashed');
    const r3 = await session.callHook('onBarClose', makeCtx('AAA', 120_000));
    expect(r3.ok).toBe(false);

    const hooksAfterLatch = driver.sent.filter((m) => (m as { t?: string }).t === 'hook').length;
    expect(hooksAfterLatch).toBe(1); // no growth — AAA's later bars never reached the harness

    // BBB is a different symbol — unaffected, still runs on the same (alive) container.
    const p4 = session.callHook('onBarClose', makeCtx('BBB', 0));
    writeOk(driver); // reply to init(BBB)
    writeOk(driver); // reply to hook(BBB, bar0)
    const r4 = await p4;
    expect(r4.ok).toBe(true);
    expect(driver.spawnCount).toBe(1);
  });

  it('an eof (container death) is session-fatal — subsequent symbols also fail-closed', async () => {
    const { session, driver } = newUniverseSession();

    const p1 = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // reply to init(AAA)
    driver.stdout.end(); // container "exited" before replying to the hook — channel death
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    expect(driver.disposeCount).toBe(1); // session-fatal: container torn down

    // Any subsequent symbol on the same (now-dead) session also fails closed, with no new spawn.
    const r2 = await session.callHook('onBarClose', makeCtx('BBB', 0));
    expect(r2.ok).toBe(false);
    expect(driver.spawnCount).toBe(1);
    expect(driver.disposeCount).toBe(1);
  });
});
