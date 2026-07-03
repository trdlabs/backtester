// Task 4 (17b bar batching), Step 3 — flag-off wire-shape regression pin. Drives the REAL
// `SandboxModuleExecutor` (not a fake at the ModuleExecutor seam) through `runBacktest` with NO
// `barBatching` in RunDeps, against a scripted auto-responding driver (no Docker). Proves two things
// at the actual sandbox wire boundary:
//   1. zero `{t:'hookBatch'}` envelopes are ever sent — `SandboxModuleExecutor.executeStrategyHookBatch`
//      is never invoked when the flag is off, even though it now exists (Task 4).
//   2. every `{t:'hook'}` envelope carries EXACTLY today's key set (`t, seq, hook, snapshot, newBar`
//      + conditional `newOi`/`newLiq`) — byte-identical to pre-17b, since Task 4 does not touch
//      `SandboxSession.callHook`/`buildHookPayload` at all.
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ModuleManifest, StrategyModule } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { createTrustedRegistry } from '../src/engine/registry.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
import { DockerDriver, type SpawnedContainer } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import { DEFAULT_RISK, DEFAULT_EXEC } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';

const TS0 = 1_781_740_800_000;
const BAR_MS = 60_000;

/** Reactive stdin recorder: parses each NDJSON line as it is written and immediately invokes
 * `onLine`, letting the test auto-respond on `stdout` without manually stepping the async runner. */
class AutoRespondWritable extends Writable {
  private acc = '';
  constructor(private readonly onLine: (parsed: Record<string, unknown>) => void) {
    super();
  }
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.acc += String(chunk);
    let nl = this.acc.indexOf('\n');
    while (nl >= 0) {
      const line = this.acc.slice(0, nl);
      this.acc = this.acc.slice(nl + 1);
      if (line.length > 0) this.onLine(JSON.parse(line) as Record<string, unknown>);
      nl = this.acc.indexOf('\n');
    }
    cb();
  }
}

class AutoRespondingDriver extends DockerDriver {
  readonly sent: Record<string, unknown>[] = [];
  readonly stdin = new AutoRespondWritable((line) => this.respond(line));
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  private respond(line: Record<string, unknown>): void {
    this.sent.push(line);
    if (line.t === 'init') {
      this.stdout.write(`${JSON.stringify({ t: 'ok', decisions: [] })}\n`);
    } else if (line.t === 'hook') {
      this.stdout.write(`${JSON.stringify({ t: 'ok', seq: line.seq, decisions: [] })}\n`);
    } else if (line.t === 'hookBatch') {
      const bars = Array.isArray(line.bars) ? line.bars : [];
      this.stdout.write(`${JSON.stringify({ t: 'okBatch', seq: line.seq, stoppedAt: Math.max(0, bars.length - 1), decisions: [] })}\n`);
    }
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

function makeCandles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ts: TS0 + i * BAR_MS, open: 100, high: 101, low: 99, close: 100, volume: 1000,
  }));
}

describe('17b bar batching — flag-off wire shape at the real sandbox boundary (Task 4, Step 3)', () => {
  it('zero hookBatch envelopes; every hook envelope keeps the pre-17b key set exactly', async () => {
    const n = 3;
    const candles = makeCandles(n);
    const dataset: CandleDataset = { datasetRef: 'fake', timeframe: '1m', symbols: () => ['TST'], candles: () => candles };

    const bundle: ModuleBundle = {
      bundleDir: '/nonexistent/test-strategy-bundle',
      manifest: { ...shortAfterPump.manifest, id: 'wire-shape', version: '1.0.0', name: 'wire-shape', hooks: ['onBarClose'] } as unknown as ModuleManifest,
      descriptor: { contractVersion: '1.0.0', kind: 'strategy', entryPoint: 'module/index.js', files: [], bundleHash: 'sha256:0' },
    };
    const module = { manifest: bundle.manifest } as unknown as StrategyModule;

    const driver = new AutoRespondingDriver();
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, { driver, harnessDir: '/fake/harness/dir' });

    const registry = createTrustedRegistry({ strategies: [module], riskProfiles: [DEFAULT_RISK], executionProfiles: [DEFAULT_EXEC] });
    const req = {
      runId: 'run-wire-shape', mode: 'research', moduleRef: { id: 'wire-shape', version: '1.0.0' },
      datasetRef: 'fake', symbols: ['TST'], timeframe: '1m',
      period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + n * BAR_MS).toISOString() },
      riskProfileRef: { id: 'default_risk', version: '1.0.0' },
      executionProfileRef: { id: 'default_exec', version: '1.0.0' },
      seed: 1, metrics: ['pnl'],
    } as unknown as BacktestRunRequest;
    // No `barBatching` key at all — the flag-off path under test.
    const deps: RunDeps = { registry, dataset, router: createTrustedRouter(executor) };

    const out = await runBacktest(req, deps);
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    expect(out.baseline.decisionRecords).toHaveLength(n);

    // 1. Never a hookBatch envelope.
    expect(driver.sent.some((l) => l.t === 'hookBatch')).toBe(false);

    // 2. Exactly one init + N hook envelopes (this module declares no 'init'/'dispose' hooks, so
    //    initStrategy/disposeStrategy send nothing beyond the open() handshake).
    const hookLines = driver.sent.filter((l) => l.t === 'hook');
    expect(hookLines).toHaveLength(n);
    expect(driver.sent.filter((l) => l.t === 'init')).toHaveLength(1);

    // 3. Byte-identical key set per hook envelope: exactly {t, seq, hook, snapshot, newBar} on this
    //    OHLCV-only fixture (no market tape ⇒ no newOi/newLiq keys).
    for (const line of hookLines) {
      expect(Object.keys(line).sort()).toEqual(['hook', 'newBar', 'seq', 'snapshot', 't']);
      expect(line.t).toBe('hook');
      expect(line.hook).toBe('onBarClose');
      expect(line.newBar).not.toBeNull();
    }
  });
});
