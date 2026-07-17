// Docker-gated: runs untrusted bundles in the real sandbox. Skips (does not fail) when no Docker
// daemon is reachable — mirrors the pg-test gating in Slice 2.

import { describe, expect, it } from 'vitest';
import type { ModuleBundle, RunResultSummary, RunStatusView } from '@trading/research-contracts';
import { createModuleManifest } from '@trdlabs/backtester-sdk/builder';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store';
import { AUTH, buildTestApp, HARNESS_DIR, runBody, testDeps } from './helpers';
import { DOCKER_AVAILABLE } from './store-factories';

const MOMENTUM =
  'export function signals(candles){ return candles.map((_,i)=> i>=2 && candles[i-1].close>candles[i-2].close); }';

function bundle(source: string): ModuleBundle {
  return {
    manifest: createModuleManifest({
      id: 'sb',
      version: '1.0.0',
      kind: 'strategy',
      name: 'Sandbox test strategy',
      summary: 'Momentum stub for sandbox execution tests.',
      rationale: 'Exercises the untrusted-bundle sandbox path.',
      hooks: ['onBarClose'],
      paramsSchema: { type: 'object' },
      capabilities: { platformSdk: true },
      dataNeeds: { closedCandlesUpToCurrent: true },
    }),
    entry: 'module.mjs',
    files: { 'module.mjs': source },
  };
}

// Generous wall time so a cold first container (under parallel test load) still finishes; the runaway
// test passes its own short wall time so it stays fast.
function sandboxSettings(wallTimeMs: number) {
  return {
    harnessDir: HARNESS_DIR,
    image: 'node:24-alpine',
    memoryMb: 256,
    cpus: 1,
    pidsLimit: 64,
    wallTimeMs,
    tmpfsMb: 64,
    user: '65534:65534',
  };
}

async function appWithSandbox(wallTimeMs = 20_000) {
  return buildTestApp({ sandbox: sandboxSettings(wallTimeMs) }, testDeps({ bundleStore: new InMemoryBundleStore() }));
}

async function statusOf(app: Awaited<ReturnType<typeof appWithSandbox>>, runId: string): Promise<RunStatusView> {
  return (await app.server.inject({ url: `/v1/runs/${runId}/status`, headers: AUTH })).json() as RunStatusView;
}

const T = 60_000;

describe.skipIf(!DOCKER_AVAILABLE)('sandbox (untrusted bundle execution)', () => {
  it(
    'runs a submitted bundle in the sandbox and completes',
    async () => {
      const app = await appWithSandbox();
      try {
        const submit = await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'sb-1', moduleBundle: bundle(MOMENTUM) }),
        });
        expect(submit.statusCode).toBe(202);
        expect(await app.drain()).toBe(1);

        expect((await statusOf(app, 'sb-1')).status).toBe('completed');
        const result = (
          await app.server.inject({ url: '/v1/runs/sb-1/result', headers: AUTH })
        ).json() as RunResultSummary;
        expect(result.evidence.bundleHash).toMatch(/^sha256:/);
        expect(result.metrics.total_bars).toBeGreaterThan(0);
        expect(result.metrics.long_bars).toBeGreaterThan(0);
      } finally {
        await app.dispose();
      }
    },
    T,
  );

  it(
    'same bundle → same result_hash (determinism independent of the sandbox environment)',
    async () => {
      const run = async (): Promise<string | undefined> => {
        const app = await appWithSandbox();
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'sb-det', moduleBundle: bundle(MOMENTUM) }),
          });
          await app.drain();
          const r = (
            await app.server.inject({ url: '/v1/runs/sb-det/result', headers: AUTH })
          ).json() as RunResultSummary;
          return r.resultHash;
        } finally {
          await app.dispose();
        }
      };
      const [h1, h2] = [await run(), await run()];
      expect(h1).toMatch(/^sha256:/);
      expect(h2).toBe(h1);
    },
    T,
  );

  it(
    'a throwing module → failed with a clear terminal_code (not a service crash)',
    async () => {
      const app = await appWithSandbox();
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'sb-throw', moduleBundle: bundle('export function signals(){ throw new Error("boom"); }') }),
        });
        await app.drain();
        const s = await statusOf(app, 'sb-throw');
        expect(s.status).toBe('failed');
        expect(s.terminalCode).toBe('sandbox_module_error');
      } finally {
        await app.dispose();
      }
    },
    T,
  );

  it(
    'invalid signal output → failed with sandbox_module_error',
    async () => {
      const app = await appWithSandbox();
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'sb-bad', moduleBundle: bundle('export function signals(c){ return c.map(()=>1); }') }),
        });
        await app.drain();
        const s = await statusOf(app, 'sb-bad');
        expect(s.status).toBe('failed');
        expect(s.terminalCode).toBe('sandbox_module_error');
      } finally {
        await app.dispose();
      }
    },
    T,
  );

  it(
    'a runaway (infinite-loop) module → timed_out with sandbox_timeout',
    async () => {
      const app = await appWithSandbox(4_000);
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'sb-loop', moduleBundle: bundle('export function signals(){ while(true){} }') }),
        });
        await app.drain();
        const s = await statusOf(app, 'sb-loop');
        expect(s.status).toBe('timed_out');
        expect(s.terminalCode).toBe('sandbox_timeout');
      } finally {
        await app.dispose();
      }
    },
    T,
  );
});
