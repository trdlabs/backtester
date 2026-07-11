// Universe-mode IPC-profile accounting. Regression + completeness for the `ipc_profile` line
// emitted on close() when BACKTESTER_IPC_PROFILE=true.
//
// Two claims are pinned here:
//   1. hookCalls counts EVERY (symbol, bar) callHook in a healthy run — N symbols × M bars = N*M,
//      with NO drop. (Corrects the "1281 vs 2157 under-count" note, which was a bar-count artifact:
//      1281 = 3×427 and 2157 = 3×719 are both clean per-symbol counts of two differently-sized runs,
//      not evidence of a dropped-call bug.)
//   2. The per-symbol `init` handshake that universe mode sends lazily (ensureSymbolInit, on each
//      symbol's first hook) is ACCOUNTED FOR in the profile: its blocking receive lands in openMs
//      (symmetric with non-universe, where init is sent inside openInner and already counted in
//      openMs), and the count of those handshakes surfaces as `symbolInits`. Before the fix this
//      handshake's IPC-wait was credited nowhere and was invisible in the profile.
//
// `SandboxSession.profileEnabled` is a `private static readonly` read from process.env once at
// class-definition (module-evaluation) time, and ES imports are hoisted before this file's own
// statements — so set the env var, then load the module with a dynamic import().
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
  runId: 'run-uni-profile-1',
  symbol: 'AAA',
  seed: 1,
  params: {},
  kind: 'strategy',
  universe: true,
  bundleHash: 'sha256:0',
};

const BAR_MS = 60_000;

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

/** Drive one universe callHook: write the init reply (only for a symbol's first bar) + the hook reply. */
async function driveHook(
  driver: ScriptedDriver,
  session: SandboxSessionType,
  symbol: string,
  barIndex: number,
  firstBarForSymbol: boolean,
): Promise<void> {
  const p = session.callHook('onBarClose', makeCtx(symbol, barIndex));
  if (firstBarForSymbol) driver.stdout.write(OK); // reply to ensureSymbolInit(symbol)
  driver.stdout.write(OK); // reply to hook(symbol, bar)
  const r = await p;
  if (!r.ok) throw new Error(`callHook failed for ${symbol}@${barIndex}: ${JSON.stringify(r.error)}`);
}

describe('SandboxSession universe-mode IPC-profile accounting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts every (symbol,bar) hook and every per-symbol init handshake', async () => {
    const driver = new ScriptedDriver();
    const session = new SandboxSession(bundle, DEFAULT_SANDBOX, cfg, driver, '/fake/harness/dir');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // 2 symbols × 2 bars = 4 hook calls; first bar of each symbol also does an init handshake.
    await driveHook(driver, session, 'AAA', 0, true);
    await driveHook(driver, session, 'AAA', 1, false);
    await driveHook(driver, session, 'BBB', 0, true);
    await driveHook(driver, session, 'BBB', 1, false);

    session.close();

    const profileLine = errSpy.mock.calls
      .map((args) => String(args[0]))
      .find((s) => s.includes('"evt":"ipc_profile"'));
    expect(profileLine).toBeDefined();
    const parsed = JSON.parse(profileLine as string) as {
      hookCalls: number;
      symbolInits: number;
      openMs: number;
    };

    // Claim 1: no dropped hook calls — exactly N×M.
    expect(parsed.hookCalls).toBe(4);
    // Claim 2: the two per-symbol init handshakes are accounted for, not invisible.
    expect(parsed.symbolInits).toBe(2);
    expect(parsed.openMs).toBeGreaterThanOrEqual(0);
  });
});
