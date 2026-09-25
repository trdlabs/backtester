// BENCH (Docker-gated) — real cold-start + per-bar IPC of the untrusted sandbox path.
//
// Self-contained + network-free: drives the PINNED image + BUILT overlay harness through the
// production seam (`SandboxSession` / `DockerDriver` / `SyncIpcChannel`) with a hand-built host
// `ctx` (only the fields `serializeContext` reads). No data port, no registry, no run → zero
// dependency on `@trading-platform/sdk`. The harness reconstructs `ctx.indicators` / `ctx.data`
// from the accumulated `newBar` stream, so on flat synthetic bars the strategy returns `idle`
// every bar (the harness still recomputes 4 indicators per bar — representative of an
// indicator-using strategy; the strategy just places no order).
//
//   RUN_BENCH=1 pnpm exec vitest run apps/backtester/test/bench-sandbox-perf.test.ts
//
// Not a CI assertion — logs a measurement table and passes if the path completes.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { SandboxSession } from '../src/engine/sandbox/sandbox-session.js';
import { DockerDriver } from '../src/engine/sandbox/docker-driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLES = resolve(HERE, 'fixtures/overlay/bundles');

const DOCKER_AVAILABLE = (() => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const K_COLD = 8; // fresh-container cold starts
const M_WARM = 1000; // warm per-bar IPC round-trips
const WARMUP = 25; // discarded warm samples

const now = () => process.hrtime.bigint();
const toMs = (a: bigint, b: bigint) => Number(b - a) / 1e6;

function stats(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length;
  const q = (p: number) => a[Math.min(n - 1, Math.max(0, Math.floor(p * n)))];
  return { n, min: a[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a[n - 1], mean: a.reduce((s, x) => s + x, 0) / (n || 1) };
}
const pad = (x: number) => (x === undefined ? '—' : x.toFixed(2)).padStart(8);
function row(label: string, s: ReturnType<typeof stats>) {
  console.log(
    `${label.padEnd(26)} n=${String(s.n).padStart(4)}  mean=${pad(s.mean)}  p50=${pad(s.p50)}  ` +
      `p95=${pad(s.p95)}  p99=${pad(s.p99)}  max=${pad(s.max)}   (ms)`,
  );
}

describe.skipIf(!DOCKER_AVAILABLE || process.env.RUN_BENCH !== '1')('BENCH sandbox perf (real container)', () => {
  it(
    'cold-start + per-bar IPC',
    async () => {
      const bundleJson = JSON.parse(readFileSync(resolve(BUNDLES, 'short-after-pump.bundle.json'), 'utf8'));
      const cfg = loadConfig();
      const policy = cfg.overlaySandbox.policy;
      const harnessDir = cfg.overlaySandbox.harnessDir;
      const symbol = 'BTCUSDT';
      const seed = 42;
      const params = { pumpPct: 10, windowMin: 20, minVolume: 1_000_000 };

      console.log('\n[bench] image   =', policy.isolation.image);
      console.log('[bench] limits  = cpus', policy.limits.cpus, ' mem', policy.limits.memoryBytes >> 20, 'MiB');

      const ee = await materializeBundle(bundleJson);
      const bundle = loadBundle(ee.bundleDir);

      const mkSession = (tag: string) =>
        new SandboxSession(
          bundle,
          policy,
          { runId: `bench-${tag}`, symbol, seed, params, kind: 'strategy', containerSuffix: `bench-${process.pid}-${tag}` },
          new DockerDriver(),
          harnessDir,
          { mode: 'bind' },
        );

      const baseTs = 1_700_000_000_000;
      const ctxAt = (i: number): any => {
        const px = 100 + Math.sin(i / 7) * 2; // gentle deterministic walk → no pump → idle every bar
        const ts = baseTs + i * 60_000;
        return {
          run: { runId: 'bench', mode: 'backtest', seed },
          params,
          symbol,
          bar: { ts, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 500_000 },
          position: null,
          pendingIntent: null,
          portfolio: { equity: 10_000, openPositions: 0 },
          clock: { now: () => ts },
          market: undefined,
        };
      };

      // ---- cold-start ×K (fresh SandboxSession.open = docker run + node boot + bundle init ack) ----
      const cold: number[] = [];
      for (let k = 0; k < K_COLD; k++) {
        const s = mkSession(`c${k}`);
        try {
          const t0 = now();
          const r = s.open();
          const dt = toMs(t0, now());
          expect(r.ok, JSON.stringify(s.error)).toBe(true);
          cold.push(dt);
        } finally {
          s.close();
        }
      }

      // ---- warm per-bar IPC ×M (one open session, advancing bar each call) ----
      const warm: number[] = [];
      const ws = mkSession('warm');
      try {
        const o = ws.open();
        expect(o.ok, JSON.stringify(ws.error)).toBe(true);
        for (let i = 0; i < M_WARM + WARMUP; i++) {
          const ctx = ctxAt(i);
          const t0 = now();
          const r = ws.callHook('onBarClose', ctx);
          const dt = toMs(t0, now());
          expect(r.ok, `callHook @${i}: ${JSON.stringify(ws.error)}`).toBe(true);
          if (i >= WARMUP) warm.push(dt);
        }
      } finally {
        ws.close();
        await ee.cleanup();
      }

      // ---- report ----
      const c = stats(cold);
      const w = stats(warm);
      console.log('\n============== SANDBOX PERF — real container, pinned image ==============');
      row(`cold-start  open() x${K_COLD}`, c);
      row(`per-bar round-trip x${M_WARM}`, w);
      console.log(
        `\nper-bar IPC p50 = ${w.p50.toFixed(2)} ms → aggregate floor for one run:\n` +
          `   1,440 bars (1d@1m)  ≈ ${((w.p50 * 1440) / 1000).toFixed(1)} s\n` +
          `  43,200 bars (30d@1m) ≈ ${((w.p50 * 43200) / 1000).toFixed(0)} s   (per symbol, serial)\n` +
          `cold-start p50 = ${c.p50.toFixed(0)} ms (paid once per symbol per run)`,
      );
      console.log('========================================================================');

      expect(cold.length).toBe(K_COLD);
      expect(warm.length).toBe(M_WARM);
    },
    300_000,
  );
});
