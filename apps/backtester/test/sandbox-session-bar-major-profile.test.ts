// Task 7 — bar-major batch IPC-profile accounting. Proves the collapse is in ROUND-TRIPS, not
// logical executions: after a batched multi-bar universe run, `barMajorBatches` (one per union-ts
// `hookBarMajor` round-trip) equals the bar count, while `hookCalls` (logical (symbol,bar) hook
// executions — `SandboxSession.callHookBarMajor` credits `healthy.length` per call, mirroring the
// lockstep `callHook` accounting) equals N symbols × bar count, UNCHANGED from the lockstep path
// (see `sandbox-session-universe-profile.test.ts`).
//
// `SandboxSession.profileEnabled` is a `private static readonly` read from process.env once at
// class-definition (module-evaluation) time, and ES imports are hoisted before this file's own
// statements — so set the env var, then load the module with a dynamic import(). Same pattern as
// `sandbox-session-universe-profile.test.ts`.
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
      name: 'fake-universe-container',
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

const cfg: SessionConfig = {
  runId: 'run-uni-bar-major-profile-1',
  symbol: 'AAA',
  seed: 1,
  params: {},
  kind: 'strategy',
  universe: true,
  bundleHash: 'sha256:0',
};

const BAR_MS = 60_000;
const SYMBOLS = ['AAA', 'BBB', 'CCC'] as const;
const BAR_COUNT = 3;

function makeCtx(symbol: string, barIndex: number): StrategyContext {
  const ts = barIndex * BAR_MS;
  return {
    run: { runId: cfg.runId, mode: 'backtest', seed: 1 },
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

const OK = `${JSON.stringify({ t: 'ok', decisions: [] })}\n`;

/**
 * Drive one batched `callHookBarMajor` round-trip for `symbols` at `barIndex`: writes one `init`
 * reply per not-yet-initialized symbol (only present on the first bar), then a single tagged
 * `okBarMajor` reply carrying `symbols.length` successful results.
 */
async function driveBarMajorHook(
  driver: ScriptedDriver,
  session: SandboxSessionType,
  symbols: readonly string[],
  barIndex: number,
  firstBar: boolean,
): Promise<void> {
  const p = session.callHookBarMajor(symbols.map((s) => makeCtx(s, barIndex)));
  if (firstBar) {
    for (let i = 0; i < symbols.length; i += 1) driver.stdout.write(OK); // per-symbol init handshake
  }
  driver.stdout.write(
    `${JSON.stringify({
      t: 'okBarMajor',
      seq: barIndex + 1,
      results: symbols.map(() => ({ ok: true, decisions: [] })),
    })}\n`,
  );
  const results = await p;
  for (const r of results) {
    if (!r.ok) throw new Error(`callHookBarMajor failed at bar ${barIndex}: ${JSON.stringify(r.error)}`);
  }
}

describe('SandboxSession bar-major batch IPC-profile accounting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('barMajorBatches equals the bar count; hookCalls equals N symbols x bar count (logical unchanged)', async () => {
    const driver = new ScriptedDriver();
    const session = new SandboxSession(bundle, DEFAULT_SANDBOX, cfg, driver, '/fake/harness/dir');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (let bar = 0; bar < BAR_COUNT; bar += 1) {
      await driveBarMajorHook(driver, session, SYMBOLS, bar, bar === 0);
    }

    session.close();

    const profileLine = errSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes('"evt":"ipc_profile"'));
    expect(profileLine).toBeDefined();
    const parsed = JSON.parse(profileLine as string) as {
      hookCalls: number;
      symbolInits: number;
      barMajorBatches: number;
      openMs: number;
    };

    // The round-trip collapse: one hookBarMajor envelope per union-ts, regardless of N.
    expect(parsed.barMajorBatches).toBe(BAR_COUNT);
    // Logical executions unchanged: every (symbol, bar) still counts, N x bar count, no drop.
    expect(parsed.hookCalls).toBe(SYMBOLS.length * BAR_COUNT);
    // Per-symbol lazy init handshakes: one per symbol, on the first bar only.
    expect(parsed.symbolInits).toBe(SYMBOLS.length);
    expect(parsed.openMs).toBeGreaterThanOrEqual(0);
  });
});
