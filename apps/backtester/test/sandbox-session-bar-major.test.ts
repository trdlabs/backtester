// Task 2 (Slice B — bar-major transport collapse) — SandboxSession.callHookBarMajor: one IPC
// round-trip carrying all N symbols' onBarClose increments in a single {t:'hookBarMajor'} envelope.
//
// Harness copied VERBATIM (ScriptedDriver / RecordingWritable / bundle / makeCtx) from
// sandbox-session-universe.test.ts — same universe cfg, same fake-driver-over-in-memory-streams
// pattern (no real Docker involved).
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
 * container). Tracks how many times spawnSession is actually invoked and the name it was spawned with.
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

/** Write a scripted `{t:'ok', decisions:[]}` response line to the fake container's stdout — used for
 * the per-symbol lazy `init` handshakes that precede a hookBarMajor round-trip. */
function writeOk(driver: ScriptedDriver, seq?: number): void {
  const body = seq === undefined ? { t: 'ok', decisions: [] } : { t: 'ok', seq, decisions: [] };
  driver.stdout.write(`${JSON.stringify(body)}\n`);
}

describe('SandboxSession.callHookBarMajor', () => {
  it('maps a tagged okBarMajor to per-ctx HookResults (ok + per-symbol error, latch the errored symbol)', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    driver.stdout.write(
      `${JSON.stringify({
        t: 'okBarMajor',
        seq: 1,
        results: [
          { ok: true, decisions: ['SIG'] },
          { ok: false, error: { code: 'sandbox_crashed', detail: 'strategy threw' } },
        ],
      })}\n`,
    );
    const results = await p;

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ok: true, decisions: ['SIG'] });
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.decisions).toEqual([]);
    expect(results[1]?.error?.code).toBe('sandbox_crashed');

    // BBB is now latched: a subsequent callHook fails closed WITHOUT sending anything new.
    const sentCountBefore = driver.sent.length;
    const r3 = await session.callHook('onBarClose', makeCtx('BBB', 60_000));
    expect(r3.ok).toBe(false);
    expect(r3.error?.code).toBe('sandbox_crashed');
    expect(driver.sent.length).toBe(sentCountBefore); // nothing new sent to the harness
  });

  it('a results-length mismatch is session-fatal (fail), not a per-symbol latch', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    driver.stdout.write(
      `${JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: true, decisions: [] }] })}\n`, // length 1, expected 2
    );
    const results = await p;

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(false);
    expect(results[0]?.error?.code).toBe('sandbox_output_malformed');
    expect(driver.disposeCount).toBe(1); // session torn down — whole-session fatal, not a per-symbol latch

    // A subsequent call on the now-dead session returns the session error, without a new spawn.
    const r2 = await session.callHookBarMajor([makeCtx('AAA', 60_000)]);
    expect(r2).toHaveLength(1);
    expect(r2[0]?.ok).toBe(false);
    expect(driver.spawnCount).toBe(1);
  });

  it('sends exactly ONE hookBarMajor envelope carrying N entries', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    driver.stdout.write(
      `${JSON.stringify({
        t: 'okBarMajor',
        seq: 1,
        results: [
          { ok: true, decisions: [] },
          { ok: true, decisions: [] },
        ],
      })}\n`,
    );
    await p;

    const envelopes = driver.sent.filter((m): m is { t: string; bars: unknown[] } => (m as { t?: string }).t === 'hookBarMajor');
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.bars).toHaveLength(2);

    const inits = driver.sent.filter((m) => (m as { t?: string }).t === 'init');
    expect(inits).toHaveLength(2);
  });

  it('a latched symbol is NOT re-sent; only the healthy symbol appears in bars (index remap)', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA0 = makeCtx('AAA', 0);
    const ctxBBB0 = makeCtx('BBB', 0);

    // 1) First call: script BBB's result as {ok:false,error} → BBB is latched.
    const p1 = session.callHookBarMajor([ctxAAA0, ctxBBB0]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    driver.stdout.write(
      `${JSON.stringify({
        t: 'okBarMajor',
        seq: 1,
        results: [
          { ok: true, decisions: ['A0'] },
          { ok: false, error: { code: 'sandbox_crashed', detail: 'strategy threw' } },
        ],
      })}\n`,
    );
    const r1 = await p1;
    expect(r1[0]).toEqual({ ok: true, decisions: ['A0'] });
    expect(r1[1]?.ok).toBe(false);
    const bbbError = r1[1]?.error;
    expect(bbbError).toBeDefined();

    // 2) Second callHookBarMajor([AAA, BBB]): BBB must NOT be re-sent.
    const ctxAAA1 = makeCtx('AAA', 60_000);
    const ctxBBB1 = makeCtx('BBB', 60_000);
    const p2 = session.callHookBarMajor([ctxAAA1, ctxBBB1]);
    // No init envelope this time: AAA already initialized, and BBB is latched (never re-sent, so no
    // init handshake is attempted for it either).
    driver.stdout.write(
      `${JSON.stringify({ t: 'okBarMajor', seq: 2, results: [{ ok: true, decisions: ['A1'] }] })}\n`, // only 1 entry: AAA
    );
    const r2 = await p2;

    const envelopes = driver.sent.filter(
      (m): m is { t: string; bars: { snapshot: { symbol: string } }[] } => (m as { t?: string }).t === 'hookBarMajor',
    );
    expect(envelopes).toHaveLength(2);
    const secondEnvelope = envelopes[1]!;
    expect(secondEnvelope.bars).toHaveLength(1); // only the healthy symbol
    expect(secondEnvelope.bars[0]?.snapshot.symbol).toBe('AAA'); // BBB not re-sent

    expect(r2).toHaveLength(2);
    expect(r2[0]).toEqual({ ok: true, decisions: ['A1'] });
    expect(r2[1]?.ok).toBe(false);
    expect(r2[1]?.error).toEqual(bbbError); // BBB's prior fail-closed error, remapped to its original index
  });

  // Task 7 — wire proofs (flag OFF/ON round-trip collapse).

  it('flag-OFF-equivalent: driving callHook per symbol (Slice A interleave) sends ZERO hookBarMajor envelopes', async () => {
    const { session, driver } = newUniverseSession();

    const pA = session.callHook('onBarClose', makeCtx('AAA', 0));
    writeOk(driver); // reply to init(AAA)
    writeOk(driver, 1); // reply to hook(AAA)
    const rA = await pA;
    expect(rA.ok).toBe(true);

    const pB = session.callHook('onBarClose', makeCtx('BBB', 0));
    writeOk(driver); // reply to init(BBB)
    writeOk(driver, 2); // reply to hook(BBB)
    const rB = await pB;
    expect(rB.ok).toBe(true);

    const envelopes = driver.sent.filter((m) => (m as { t?: string }).t === 'hookBarMajor');
    expect(envelopes).toHaveLength(0);
    const hookEnvelopes = driver.sent.filter((m) => (m as { t?: string }).t === 'hook');
    expect(hookEnvelopes).toHaveLength(2); // AAA + BBB, each its own round-trip
  });

  it('flag-ON: callHookBarMajor([ctxA,ctxB]) sends EXACTLY ONE hookBarMajor envelope with bars.length===2', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    driver.stdout.write(
      `${JSON.stringify({
        t: 'okBarMajor',
        seq: 1,
        results: [
          { ok: true, decisions: [] },
          { ok: true, decisions: [] },
        ],
      })}\n`,
    );
    await p;

    const envelopes = driver.sent.filter((m): m is { t: string; bars: unknown[] } => (m as { t?: string }).t === 'hookBarMajor');
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.bars).toHaveLength(2);
  });

  // Task 7 — channel-fatal guardrail 2, second shape: a non-okBarMajor reply (wrong response kind,
  // not just a short results array) is session-fatal too, not a per-symbol latch.
  it('a non-okBarMajor reply (wrong response kind) is session-fatal (fail), not a per-symbol latch', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver); // reply to init(AAA)
    writeOk(driver); // reply to init(BBB)
    // Harness incorrectly replies with a plain `ok` (single-hook shape) instead of `okBarMajor`.
    driver.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
    const results = await p;

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false);
    expect(results[1]?.ok).toBe(false);
    expect(driver.disposeCount).toBe(1); // session torn down — whole-session fatal, not a per-symbol latch

    // A subsequent call on the now-dead session returns the session error, without a new spawn.
    const r2 = await session.callHookBarMajor([makeCtx('AAA', 60_000)]);
    expect(r2).toHaveLength(1);
    expect(r2[0]?.ok).toBe(false);
    expect(driver.spawnCount).toBe(1);
  });

  // P3-9 — a per-symbol INIT soft failure inside a bar-major batch must drop ONLY that symbol from the
  // envelope (like a pre-latched symbol), keep the shared container alive, and remap the healthy
  // symbols back to their ORIGINAL ctx indices (alignment preserved). Pre-fix, ensureSymbolInit's
  // fail() on the init err would tear the whole session down and fail every symbol in the batch.
  it('an init err drops only that symbol from the batch — healthy symbols keep their alignment (P3-9)', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    // init(AAA) → harness err (no seq — init carries none): AAA soft-latched, dropped from the batch.
    driver.stdout.write(`${JSON.stringify({ t: 'err', code: 'sandbox_crashed', detail: 'init threw', hook: 'onBarClose' })}
`);
    writeOk(driver); // init(BBB) → ok
    // hookBarMajor is sent for BBB ONLY → exactly one result.
    driver.stdout.write(`${JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: true, decisions: ['SIG'] }] })}
`);
    const results = await p;

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false); // AAA — fail-closed from the init latch, at its original index 0
    expect(results[0]?.error?.code).toBe('sandbox_crashed');
    expect(results[1]).toEqual({ ok: true, decisions: ['SIG'] }); // BBB — healthy, aligned to index 1
    expect(driver.disposeCount).toBe(0); // container alive — NOT session-fatal

    const envelopes = driver.sent.filter(
      (m): m is { t: string; bars: { snapshot: { symbol: string } }[] } => (m as { t?: string }).t === 'hookBarMajor',
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.bars).toHaveLength(1); // only the healthy symbol (BBB)
    expect(envelopes[0]?.bars[0]?.snapshot.symbol).toBe('BBB');
  });

  // P3-9 (review follow-up) — a CHANNEL DEATH during a LATER symbol's init (after an earlier symbol
  // already initialized successfully) is session-fatal for the whole bar-major batch, not a per-symbol
  // latch: ensureSymbolInit's channel-death branch calls fail(), and the init loop's this.failed guard
  // routes to failHealthy → every symbol in the batch fails closed and the container is torn down.
  it('a channel death during a later symbol init is session-fatal for the whole bar-major batch (P3-9)', async () => {
    const { session, driver } = newUniverseSession();
    const ctxAAA = makeCtx('AAA', 0);
    const ctxBBB = makeCtx('BBB', 0);

    const p = session.callHookBarMajor([ctxAAA, ctxBBB]);
    writeOk(driver);     // init(AAA) → ok (one successful init first)
    driver.stdout.end(); // init(BBB) never answered — channel death AFTER AAA's successful init
    const results = await p;

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false); // both fail-closed — session-fatal, not a per-symbol latch
    expect(results[1]?.ok).toBe(false);
    expect(driver.disposeCount).toBe(1); // container torn down

    // A subsequent call on the now-dead session fails closed too, with no new spawn.
    const r2 = await session.callHookBarMajor([makeCtx('AAA', 60_000)]);
    expect(r2[0]?.ok).toBe(false);
    expect(driver.spawnCount).toBe(1);
  });
});
