// BENCH (Docker-gated) — serial-vs-parallel drain of REAL sandboxed overlay runs.
//
// Answers one question: does the perf #2 worker pool (`drainQueue` → `runBoundedPool`) actually
// speed up a parameter SWEEP of untrusted (sandboxed) strategies, or do the runs serialize?
//
// It drives the SHIPPED production path: submit N identical overlay+bundle runs to a test app, then
// time `app.drain()` once with WORKER_CONCURRENCY=1 (serial) and once with =N (parallel). Same N
// fresh jobs each time, same fixture tape, same bundle → the only variable is concurrency.
//
// A pure-async control (the same `runBoundedPool`, but each task just `await`s a timer) proves the
// pool DOES overlap work that yields the event loop — so any failure to speed up the sandbox path is
// attributable to the sandbox run itself (synchronous, event-loop-blocking IPC), not to the pool.
//
//   RUN_BENCH=1 pnpm exec vitest run apps/backtester/test/bench-parallel-drain.test.ts
//   RUN_BENCH=1 BENCH_N=8 pnpm exec vitest run apps/backtester/test/bench-parallel-drain.test.ts
//
// Not a CI assertion — logs a measurement table; passes if every run completes.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BacktestRunRequest, ModuleBundle, RunResultSummary } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';
import { runBoundedPool } from '../src/jobs/pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_REQUESTS_DIR = resolve(HERE, 'fixtures/overlay/requests');
const OVERLAY_BUNDLES_DIR = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (name: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
const loadInlineBundle = (name: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(OVERLAY_BUNDLES_DIR, name), 'utf8')) as ModuleBundle;

const N = Math.max(2, Number(process.env.BENCH_N ?? 6));

const now = () => process.hrtime.bigint();
const toMs = (a: bigint, b: bigint) => Number(b - a) / 1e6;

/** Submit N identical overlay+bundle runs (distinct runId/seed), then time one `app.drain()`. */
async function timedSandboxDrain(concurrency: number): Promise<number> {
  const app = await buildTestApp({ enableOverlayEngine: true, workerConcurrency: concurrency });
  try {
    const variantReq = loadRequest('variant.json');
    const bundle = loadInlineBundle('early-exit-short-after-pump.bundle.json');
    for (let i = 0; i < N; i += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: {
          ...variantReq,
          runId: `bench-c${concurrency}-${i}`,
          seed: 1000 + i,
          engine: 'overlay',
          moduleBundle: bundle,
        },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
    }

    const t0 = now();
    const processed = await app.drain();
    const dt = toMs(t0, now());
    expect(processed).toBe(N);

    // sanity: every job actually completed through the sandbox
    for (let i = 0; i < N; i += 1) {
      const r = (
        await app.server.inject({ url: `/v1/runs/bench-c${concurrency}-${i}/result`, headers: AUTH })
      ).json() as RunResultSummary;
      expect(r.status, `run ${i}: ${JSON.stringify(r)}`).toBe('completed');
    }
    return dt;
  } finally {
    await app.dispose();
  }
}

/** Control: N pure-async tasks (each awaits `delayMs`) through the same pool. */
async function timedAsyncControl(concurrency: number, delayMs: number): Promise<number> {
  let issued = 0;
  const next = async (): Promise<boolean> => {
    if (issued >= N) return false;
    issued += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    return true;
  };
  const t0 = now();
  const processed = await runBoundedPool(concurrency, next);
  const dt = toMs(t0, now());
  expect(processed).toBe(N);
  return dt;
}

describe.skipIf(!DOCKER_AVAILABLE || process.env.RUN_BENCH !== '1')(
  'BENCH parallel drain (real sandbox)',
  () => {
    it(
      'serial vs parallel drain of N sandboxed overlay runs',
      async () => {
        console.log(`\n[bench] N = ${N} sandboxed overlay runs; docker = available`);

        // Warmup (discarded): image already pulled in CI; this absorbs any first-run JIT / fs cost.
        await timedSandboxDrain(1);

        const serial = await timedSandboxDrain(1);
        const parallel = await timedSandboxDrain(N);
        const speedup = serial / parallel;

        // Control proves the pool itself parallelizes yielding work (~N×).
        const ctlDelay = Math.max(20, Math.round(serial / N)); // ≈ one run's wall-clock
        const ctlSerial = await timedAsyncControl(1, ctlDelay);
        const ctlParallel = await timedAsyncControl(N, ctlDelay);
        const ctlSpeedup = ctlSerial / ctlParallel;

        const pad = (x: number) => x.toFixed(1).padStart(9);
        console.log('\n============== PARALLEL DRAIN — serial vs parallel ==============');
        console.log(`sandbox  serial  (c=1)   total=${pad(serial)} ms   per-run=${pad(serial / N)} ms`);
        console.log(`sandbox  parallel(c=${N})   total=${pad(parallel)} ms   per-run=${pad(parallel / N)} ms`);
        console.log(`sandbox  SPEEDUP          ${speedup.toFixed(2)}×   (ideal ≈ ${N}×)`);
        console.log('----------------------------------------------------------------');
        console.log(`control  serial  (c=1)   total=${pad(ctlSerial)} ms   (delay=${ctlDelay} ms ×${N})`);
        console.log(`control  parallel(c=${N})   total=${pad(ctlParallel)} ms`);
        console.log(`control  SPEEDUP          ${ctlSpeedup.toFixed(2)}×   (pool-mechanism check)`);
        console.log('----------------------------------------------------------------');
        console.log(
          speedup >= 1.5
            ? `VERDICT: parallel drain speeds up the sandbox path (${speedup.toFixed(2)}×).`
            : `VERDICT: NO meaningful sandbox speedup (${speedup.toFixed(2)}×) despite the pool working ` +
              `(control ${ctlSpeedup.toFixed(2)}×) → runs serialize on synchronous, event-loop-blocking IPC.`,
        );
        console.log('================================================================');

        // The control MUST show the pool parallelizes; otherwise the measurement is meaningless.
        expect(ctlSpeedup).toBeGreaterThan(1.5);
      },
      600_000,
    );
  },
);
