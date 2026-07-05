// 17b review item (a) — callHookBatch must update the profiling counters (profIpcWaitMs around the
// receive, profHookCalls += stoppedAt + 1) exactly like callHook does, gated on the same
// BACKTESTER_IPC_PROFILE flag. `SandboxSession.profileEnabled` is a `private static readonly`
// evaluated once from `process.env` at class-definition time (i.e. at module-evaluation time), and
// ES module imports are hoisted and evaluated BEFORE any of this file's own top-level statements
// regardless of source order — so a plain top-of-file `process.env...=` assignment above a static
// `import` does NOT run first. We set the env var, then load the module with a dynamic `import()`
// (type-only imports below are erased at compile time, so they don't trigger eager evaluation).
process.env.BACKTESTER_IPC_PROFILE = 'true';

import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleManifest, StrategyContext } from '@trading/research-contracts/research';
import type { SandboxSession as SandboxSessionType, SessionConfig } from '../src/engine/sandbox/sandbox-session.js';
import { DockerDriver, type SpawnedContainer } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';

const { SandboxSession } = (await import('../src/engine/sandbox/sandbox-session.js')) as {
  SandboxSession: typeof SandboxSessionType;
};

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

class ScriptedDriver extends DockerDriver {
  readonly stdin = new RecordingWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

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
    /* no-op */
  }
}

const bundle = {
  bundleDir: '/nonexistent/test-strategy-bundle',
  manifest: { id: 'test_strategy', version: '1.0.0', kind: 'strategy', hooks: ['onBarClose'] } as unknown as ModuleManifest,
  descriptor: { contractVersion: '1.0.0', kind: 'strategy', entryPoint: 'module/index.js', files: [], bundleHash: 'sha256:0' },
} as unknown as ConstructorParameters<typeof SandboxSessionType>[0];

const cfg: SessionConfig = { runId: 'run-profile-1', symbol: 'BTCUSDT', seed: 1, params: {}, kind: 'strategy' };

function makeCtx(ts: number): StrategyContext {
  return {
    run: { runId: 'run-profile-1', mode: 'backtest', seed: 1 },
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

async function scriptOpen(driver: ScriptedDriver, session: SandboxSessionType): Promise<void> {
  const opening = session.open();
  driver.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
  const res = await opening;
  if (!res.ok) throw new Error(`test setup: open() failed: ${JSON.stringify(res.error)}`);
}

describe('SandboxSession.callHookBatch profiling parity (17b review item a)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('credits profHookCalls += stoppedAt + 1 and accumulates profIpcWaitMs, dumped on close()', async () => {
    const driver = new ScriptedDriver();
    const session = new SandboxSession(bundle, DEFAULT_SANDBOX, cfg, driver, '/fake/harness/dir');
    await scriptOpen(driver, session);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const ctxs = [0, 1, 2, 3, 4].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 2, decisions: ['SIGNAL'] })}\n`);
    const result = await batchPromise;
    expect(result).toEqual({ ok: true, stoppedAt: 2, decisions: ['SIGNAL'] });

    session.close();

    const profileLine = errSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes('"evt":"ipc_profile"'));
    expect(profileLine).toBeDefined();
    const parsed = JSON.parse(profileLine as string) as { hookCalls: number; ipcWaitMs: number };
    // stoppedAt (2) + 1 = 3 bars actually executed by the harness in this one batch call.
    expect(parsed.hookCalls).toBe(3);
    expect(parsed.ipcWaitMs).toBeGreaterThanOrEqual(0);
  });

  it('a fail-closed batch (stoppedAt: -1) credits zero hook calls — no profile line on close()', async () => {
    const driver = new ScriptedDriver();
    const session = new SandboxSession(bundle, DEFAULT_SANDBOX, cfg, driver, '/fake/harness/dir');
    await scriptOpen(driver, session);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const ctxs = [0, 1].map((i) => makeCtx(i * BAR_MS));
    const batchPromise = session.callHookBatch(ctxs);
    driver.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: 1, stoppedAt: 99, decisions: [] })}\n`); // out of range
    const result = await batchPromise;
    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(-1);

    session.close();

    const profileLine = errSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes('"evt":"ipc_profile"'));
    // close()'s dump gate is `profHookCalls > 0` — a fully-failed batch credits 0, so no line at all.
    expect(profileLine).toBeUndefined();
  });
});
