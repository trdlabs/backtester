// BENCH (Docker-gated) — multi-PROCESS worker throughput. Proves that M separate `worker-main`
// OS processes draining one shared Postgres queue parallelize backtests across cores — which a single
// Node process structurally cannot (one event loop). Spins its own throwaway postgres:16-alpine.
//
// Two modes:
//   BENCH_MODE=momentum (default) — CPU-bound trusted in-process runs; enqueued directly as 'accepted'
//     then bulk-flipped to 'queued' AFTER worker warmup (so the timer measures pure parallel drain).
//   BENCH_MODE=sandbox — REAL Docker-container overlay runs (production path). An API node (autoWorker
//     off) submits overlay+bundle jobs via HTTP; workers run them with the session budget bumped via
//     BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION (the sub#4 knob — already exists).
//
//   pnpm exec tsx scripts/bench-workers.mts
//   BENCH_MODE=sandbox BENCH_N=12 pnpm exec tsx scripts/bench-workers.mts
//
// Not a CI assertion — prints a measurement table.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createPool } from '../src/db/pool.js';
import { migrate, DEFAULT_MIGRATIONS_DIR } from '../src/db/migrate.js';
import { PgJobStore } from '../src/jobs/pg-job-store.js';
import type { JobStore, NewJob } from '../src/jobs/job-store.js';
import type { RunSubmitRequest } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const MODE = (process.env.BENCH_MODE ?? 'momentum') as 'momentum' | 'sandbox';
const N = Math.max(1, Number(process.env.BENCH_N ?? (MODE === 'sandbox' ? 12 : 120)));
const CONC = (process.env.BENCH_CONC ?? '1,2,4').split(',').map((s) => Math.max(1, Number(s.trim())));
const PG_PORT = Number(process.env.BENCH_PG_PORT ?? 55432);
const API_PORT = Number(process.env.BENCH_API_PORT ?? 18080);
const PG_NAME = 'bench-workers-pg';
const DB_URL = `postgres://postgres:bench@127.0.0.1:${PG_PORT}/postgres`;
const AUTH = 'bench-token';
const SESSION_BUDGET_MS = String(process.env.BENCH_SESSION_BUDGET_MS ?? 600_000); // sub#4 knob, bumped

const now = () => process.hrtime.bigint();
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

async function startPg(): Promise<void> {
  try { execFileSync('docker', ['rm', '-f', PG_NAME], { stdio: 'ignore' }); } catch { /* none */ }
  sh('docker', ['run', '-d', '--name', PG_NAME, '-e', 'POSTGRES_PASSWORD=bench',
    '-e', 'POSTGRES_DB=postgres', '-p', `${PG_PORT}:5432`, 'postgres:16-alpine']);
  for (let i = 0; i < 60; i += 1) {
    const probe = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 1000 });
    try { await probe.query('SELECT 1'); await probe.end(); return; }
    catch { await probe.end().catch(() => {}); await sleep(1000); }
  }
  throw new Error('postgres did not become ready in 60s');
}
function stopPg(): void {
  try { execFileSync('docker', ['rm', '-f', PG_NAME], { stdio: 'ignore' }); } catch { /* none */ }
}

const workerBaseEnv = (id: string): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: DB_URL,
  BACKTESTER_DATA_SOURCE: 'fixture',
  WORKER_ID: id,
  WORKER_CONCURRENCY: '1',
  WORKER_POLL_MS: '10',
  WORKER_HEARTBEAT_MS: '1000',
  WORKER_LEASE_TTL_MS: '30000',
  ...(MODE === 'sandbox'
    ? { BACKTESTER_ENABLE_OVERLAY_ENGINE: 'true', BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION: SESSION_BUDGET_MS }
    : {}),
});

function spawnWorker(id: string): ChildProcess {
  return spawn('pnpm', ['exec', 'tsx', 'src/worker-main.ts'], { cwd: APP_DIR, env: workerBaseEnv(id), stdio: 'ignore' });
}

async function activeCount(pool: Pool, prefix: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM backtest_job WHERE run_id LIKE $1 AND status IN ('queued','running')`,
    [`${prefix}-%`],
  );
  return Number(r.rows[0]?.n ?? 0);
}
async function statusCounts(pool: Pool, prefix: string): Promise<Record<string, number>> {
  const r = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text n FROM backtest_job WHERE run_id LIKE $1 GROUP BY status`,
    [`${prefix}-%`],
  );
  return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
}

// ---- momentum: direct enqueue (accepted → bulk release to queued) ----
function momentumRequest(seed: number): RunSubmitRequest {
  return {
    mode: 'research', moduleRef: { id: 'smoke', version: '1.0.0' }, datasetRef: 'smoke-btc-1m',
    symbols: ['BTCUSDT'], timeframe: '1m',
    period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' }, seed, metrics: [],
  } as RunSubmitRequest;
}
async function insertAccepted(store: JobStore, prefix: string, n: number, atMs: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const runId = `${prefix}-${i}`;
    const job: NewJob = {
      jobId: randomUUID(), runId, requestFingerprint: `fp-${runId}`, request: momentumRequest(1000 + i),
      effectiveSeed: 1000 + i, datasetRef: 'smoke-btc-1m', runTimeoutMs: 3_600_000, acceptedAtMs: atMs,
    };
    await store.insertOrGet(job);
  }
}
async function releaseQueued(pool: Pool, prefix: string, atMs: number): Promise<void> {
  await pool.query(
    `UPDATE backtest_job SET status='queued', queued_at_ms=$2::bigint, timeline_json = timeline_json || $3::jsonb
     WHERE run_id LIKE $1 AND status='accepted'`,
    [`${prefix}-%`, atMs, JSON.stringify([{ status: 'queued', atMs }])],
  );
}

// ---- sandbox: submit overlay+bundle jobs through a real API node (real submit → bundleStore) ----
const variantReq = JSON.parse(readFileSync(resolve(APP_DIR, 'test/fixtures/overlay/requests/variant.json'), 'utf8'));
const overlayBundle = JSON.parse(readFileSync(resolve(APP_DIR, 'test/fixtures/overlay/bundles/early-exit-short-after-pump.bundle.json'), 'utf8'));

function startApiNode(): ChildProcess {
  return spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      BACKTESTER_DATA_SOURCE: 'fixture',
      BACKTESTER_AUTO_WORKER: 'false', // API node: serve HTTP only, do NOT drain
      BACKTESTER_ENABLE_OVERLAY_ENGINE: 'true',
      BACKTESTER_PORT: String(API_PORT),
      BACKTESTER_AUTH_TOKEN: AUTH,
      BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION: SESSION_BUDGET_MS,
    },
    stdio: 'ignore',
  });
}
async function waitApiReady(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/v1/runs`, { headers: { authorization: `Bearer ${AUTH}` } });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('API node did not become ready in 60s');
}
async function submitSandbox(prefix: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AUTH}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...variantReq, runId: `${prefix}-${i}`, seed: 1000 + i, engine: 'overlay', moduleBundle: overlayBundle }),
    });
    if (res.status !== 202) throw new Error(`submit ${prefix}-${i} -> ${res.status}: ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  console.log(`[bench-workers] mode=${MODE} N=${N}/round conc=${CONC.join('/')} cores=${cpus().length} pg=${PG_PORT}${MODE === 'sandbox' ? ` api=${API_PORT} budget=${SESSION_BUDGET_MS}ms` : ''}`);
  await startPg();
  const adminPool = createPool(DB_URL);
  let api: ChildProcess | undefined;
  try {
    await migrate(adminPool, DEFAULT_MIGRATIONS_DIR);
    const store = new PgJobStore(adminPool);
    if (MODE === 'sandbox') { api = startApiNode(); await waitApiReady(); }

    const results: { conc: number; drainMs: number; perRun: number; completed: number }[] = [];
    for (const conc of CONC) {
      const prefix = `r${conc}-${Date.now().toString(36)}`;
      const workers = Array.from({ length: conc }, (_, i) => spawnWorker(`${prefix}-w${i}`));
      try {
        await sleep(MODE === 'sandbox' ? 5000 : 4000); // warmup: boot + connect + idle-poll empty queue
        let t0: bigint;
        if (MODE === 'momentum') {
          await insertAccepted(store, prefix, N, Date.now());
          t0 = now();
          await releaseQueued(adminPool, prefix, Date.now());
        } else {
          // sandbox: workers are warm + idle; submit makes jobs claimable as they post (slow runs → tiny overlap)
          t0 = now();
          await submitSandbox(prefix, N);
        }
        let active = await activeCount(adminPool, prefix);
        const deadline = Date.now() + 600_000;
        while (active > 0) {
          if (Date.now() > deadline) throw new Error(`drain timed out (conc=${conc}); ${JSON.stringify(await statusCounts(adminPool, prefix))}`);
          await sleep(MODE === 'sandbox' ? 100 : 10);
          active = await activeCount(adminPool, prefix);
        }
        const drainMs = ms(t0, now());
        const counts = await statusCounts(adminPool, prefix);
        const completed = counts.completed ?? 0;
        results.push({ conc, drainMs, perRun: drainMs / N, completed });
        console.log(`  conc=${conc}: drain=${drainMs.toFixed(0)}ms  per-run=${(drainMs / N).toFixed(1)}ms  ${JSON.stringify(counts)}`);
      } finally {
        for (const w of workers) w.kill('SIGTERM');
        await sleep(2000);
        for (const w of workers) if (!w.killed) w.kill('SIGKILL');
      }
    }

    const base = results.find((r) => r.conc === 1)?.drainMs;
    console.log(`\n============== MULTI-PROCESS WORKER THROUGHPUT (${MODE}) ==============`);
    for (const r of results) {
      const speedup = base ? base / r.drainMs : 1;
      console.log(`  ${r.conc} worker(s): ${r.drainMs.toFixed(0).padStart(8)} ms   ${r.perRun.toFixed(1).padStart(7)} ms/run   speedup ${speedup.toFixed(2)}×   (completed ${r.completed}/${N})`);
    }
    console.log(`cores=${cpus().length}  N=${N}/round  mode=${MODE}`);
    console.log('=======================================================================');
  } finally {
    if (api) { api.kill('SIGTERM'); await sleep(1500); if (!api.killed) api.kill('SIGKILL'); }
    await adminPool.end().catch(() => {});
    stopPg();
  }
}

main().catch((err) => { console.error(err); stopPg(); process.exit(1); });
