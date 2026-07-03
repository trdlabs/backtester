// Task 3 (17b bar batching) — SandboxSession.callHookBatch, host-side unit test against a SCRIPTED
// fake channel/driver (no Docker). Mirrors the fail-close-without-Docker pattern already used by
// sandbox-apply-observability.test.ts (a DockerDriver subclass that never touches a real daemon),
// extended here to a full fake container: spawnSession() hands back in-memory streams the test
// drives directly as the NDJSON wire, instead of a driver that just throws on spawn.
//
// Also pins the host<->harness tail-boundary CONTRACT for callHookBatch's early-stop rewind (see
// SandboxSession.callHookBatch's doc comment): after an okBatch mid-stop, the NEXT call must resend
// the first bar the harness never consumed — proven here by inspecting what actually gets written to
// the fake stdin, not just the returned stoppedAt.
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest, StrategyContext } from '@trading/research-contracts/research';
import { SandboxSession, type SessionConfig, type BatchHookResult } from '../src/engine/sandbox/sandbox-session.js';
import { DockerDriver, type SpawnedContainer } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import type { SandboxPolicy } from '../src/engine/sandbox-policy.js';
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
 * container) — the test writes scripted NDJSON response lines directly to `stdout` and reads what
 * SandboxSession sent via `sent`. `inspectState`/`dispose` are stubbed so close()/mapFailure's eof
 * branch never shell out for real.
 */
class ScriptedDriver extends DockerDriver {
  readonly stdin = new RecordingWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  get sent(): unknown[] {
    return this.stdin.sent;
  }

  override spawnSession(): SpawnedContainer {
    return {
      name: 'fake-container',
      child: { stdin: this.stdin, stdout: this.stdout, stderr: this.stderr } as unknown as ChildProcessWithoutNullStreams,
    };
  }

  override inspectState(): { oomKilled: boolean; exitCode: number; running: boolean } | undefined {
    return undefined;
  }

  override dispose(): void {
    /* no-op — nothing real to tear down */
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

const cfg: SessionConfig = { runId: 'run-test-1', symbol: 'BTCUSDT', seed: 1, params: {}, kind: 'strategy' };

function newSession(policy: SandboxPolicy = DEFAULT_SANDBOX): { session: SandboxSession; driver: ScriptedDriver } {
  const driver = new ScriptedDriver();
  const session = new SandboxSession(bundle, policy, cfg, driver, '/fake/harness/dir');
  return { session, driver };
}

/** Minimal StrategyContext double — only the fields callHook/callHookBatch's buildHookPayload and
 * context-serializer's serializeContext actually read. ctx.market is omitted (OHLCV-only). */
function makeCtx(ts: number): StrategyContext {
  return {
    run: { runId: 'run-test-1', mode: 'backtest', seed: 1 },
    params: {},
    symbol: 'BTCUSDT',
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

const BAR_MS = 60_000;

/** Narrow a BatchHookResult to its `ok: false` branch (asserts + type-guards in one call). */
function expectFailed(result: BatchHookResult): asserts result is Extract<BatchHookResult, { ok: false }> {
  expect(result.ok).toBe(false);
}

/** Drive the init handshake: send() happens synchronously inside open(), so writing the scripted
 * response AFTER calling open() (before awaiting it) is safe — the receive() waiter is registered
 * synchronously up to its first await, same ordering guarantee AsyncIpcChannel documents. */
async function scriptOpen(driver: ScriptedDriver, session: SandboxSession): Promise<void> {
  const opening = session.open();
  driver.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
  const res = await opening;
  if (!res.ok) throw new Error(`test setup: open() failed: ${JSON.stringify(res.error)}`);
}

describe('SandboxSession.callHookBatch (17b — inert protocol, scripted fake channel)', () => {
  it('okBatch mid-stop propagates stoppedAt/decisions; the NEXT call resends the first unconsumed bar', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3, 4].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 2, decisions: ['SIGNAL'] })}\n`);
    const result = await batchPromise;

    expect(result).toEqual({ ok: true, stoppedAt: 2, decisions: ['SIGNAL'] });

    // Bookkeeping must be rewound to "state after entry 2" (barIndex=2), NOT "after entry 4" — the
    // NEXT lockstep call for bar 3 (the first bar the harness never consumed) must see a fresh
    // newBar and barIndex 3, proving the resend boundary agrees with the harness's own (see
    // harness-hook-batch.test.ts case c for the harness-side half of this same contract).
    const nextPromise = session.callHook('onBarClose', ctxs[3]!);
    driver.stdout.write(`${JSON.stringify({ t: 'ok', seq: 2, decisions: [] })}\n`);
    await nextPromise;

    expect(driver.sent).toHaveLength(3); // [0]=init, [1]=hookBatch request, [2]=this callHook request
    const sentReq = driver.sent[2] as { t: string; newBar: { ts: number } | null; snapshot: { barIndex: number } };
    expect(sentReq.t).toBe('hook');
    expect(sentReq.newBar).toEqual({ ts: 3 * BAR_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    expect(sentReq.snapshot.barIndex).toBe(3);
  });

  it('err with barOffset attributes error.barIndex to the failing bar and fails the session closed', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(
      `${JSON.stringify({ t: 'err', seq: 1, hook: 'onBarClose', code: 'sandbox_crashed', detail: 'boom', barOffset: 1 })}\n`,
    );
    const result = await batchPromise;

    expectFailed(result);
    expect(result.stoppedAt).toBe(0); // barOffset - 1
    expect(result.error?.code).toBe('sandbox_crashed');
    // firstBarIndexBefore (-1, fresh session) + 1 + barOffset (1) = 1: absolute index of the failing bar.
    expect(result.error?.barIndex).toBe(1);

    // Fail-closed: the session is now dead — a subsequent call short-circuits WITHOUT sending anything.
    const sentBefore = driver.sent.length;
    const again = await session.callHookBatch(ctxs);
    expect(again).toEqual({ ok: false, stoppedAt: -1, error: result.error });
    expect(driver.sent.length).toBe(sentBefore);
  });

  it('okBatch with an out-of-range integer stoppedAt fails closed without throwing (hostile/broken harness line)', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3, 4].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 7, decisions: [] })}\n`); // N=5

    // Must resolve — NOT throw — with a failed-closed result.
    const result = await batchPromise;
    expectFailed(result);
    expect(result.stoppedAt).toBe(-1);
    expect(result.error?.code).toBe('sandbox_output_malformed');

    // Fail-closed: the session is now dead — a subsequent call short-circuits WITHOUT sending anything.
    const sentBefore = driver.sent.length;
    const again = await session.callHookBatch(ctxs);
    expect(again).toEqual({ ok: false, stoppedAt: -1, error: result.error });
    expect(driver.sent.length).toBe(sentBefore);
  });

  it('okBatch with a fractional stoppedAt fails closed without throwing', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3, 4].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 1.5, decisions: [] })}\n`);

    const result = await batchPromise;
    expectFailed(result);
    expect(result.stoppedAt).toBe(-1);
    expect(result.error?.code).toBe('sandbox_output_malformed');
  });

  it('okBatch with an Infinity stoppedAt fails closed without throwing (JSON.parse("1e999") still passes typeof === "number")', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3, 4].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    // Written raw (not via JSON.stringify, which would serialize Infinity as `null`) to reproduce
    // exactly the wire bytes a hostile/broken harness line would send.
    driver.stdout.write('{"t":"okBatch","seq":1,"stoppedAt":1e999,"decisions":[]}\n');

    const result = await batchPromise;
    expectFailed(result);
    expect(result.stoppedAt).toBe(-1);
    expect(result.error?.code).toBe('sandbox_output_malformed');
  });

  it('err with an out-of-range barOffset falls through to the generic error mapping (no snapshot indexing crash)', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2, 3].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(
      `${JSON.stringify({ t: 'err', seq: 1, hook: 'onBarClose', code: 'sandbox_crashed', detail: 'boom', barOffset: 99 })}\n`,
    );

    const result = await batchPromise;
    expectFailed(result);
    expect(result.stoppedAt).toBe(-1);
    expect(result.error?.code).toBe('sandbox_crashed');

    // Fail-closed: the session is now dead — a subsequent call short-circuits WITHOUT sending anything.
    const sentBefore = driver.sent.length;
    const again = await session.callHookBatch(ctxs);
    expect(again).toEqual({ ok: false, stoppedAt: -1, error: result.error });
    expect(driver.sent.length).toBe(sentBefore);
  });

  it('fully-empty batch (no decisions anywhere): stoppedAt = N-1', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1, 2].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 2, decisions: [] })}\n`);
    const result = await batchPromise;

    expect(result).toEqual({ ok: true, stoppedAt: 2, decisions: [] });
  });

  it('eof outcome maps exactly like callHook (shared mapFailure) and fails closed', async () => {
    const { session, driver } = newSession();
    await scriptOpen(driver, session);

    const ctxs = [0, 1].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.end(); // container "exited" — no response line ever arrives
    const result = await batchPromise;

    expectFailed(result);
    expect(result.stoppedAt).toBe(-1);
    // Same eofCode convention callHook uses ('sandbox_crashed', since inspectState reports no OOM).
    expect(result.error?.code).toBe('sandbox_crashed');
  });

  it('timeout outcome maps exactly like callHook (shared mapFailure) and fails closed', async () => {
    const shortPolicy: SandboxPolicy = {
      ...DEFAULT_SANDBOX,
      limits: { ...DEFAULT_SANDBOX.limits, wallTimeMsPerCall: 30 },
    };
    const { session, driver } = newSession(shortPolicy);
    await scriptOpen(driver, session);

    const ctxs = [makeCtx(0)];
    const result = await session.callHookBatch(ctxs); // nothing ever written to stdout → times out

    expectFailed(result);
    expect(result.error?.code).toBe('sandbox_timeout');
  });
});
