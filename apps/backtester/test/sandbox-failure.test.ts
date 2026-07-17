// Non-Docker sandbox failure modes.
// Covers job lifecycle when sandbox infrastructure fails before Docker is invoked:
//   missing_module  — bundle not present in the worker store
//   sandbox_module_error — executor built with null-source bundle (pre-Docker guard)
//   runner_failure  — unexpected store error during processing

import { describe, expect, it } from 'vitest';
import type { ModuleBundle, RunStatusView } from '@trading/research-contracts';
import { createModuleManifest } from '@trdlabs/backtester-sdk/builder';
import type { BundleStore } from '../src/sandbox/bundle-store';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store';
import { InMemoryJobStore } from '../src/jobs/job-store';
import { AUTH, buildTestApp, runBody, testDeps } from './helpers';

/**
 * A structurally valid bundle that passes validateBundle (entry is in files, source is a string).
 * Used for submission; the infrastructure failure happens after the bundle is stored.
 */
function minimalBundle(): ModuleBundle {
  return {
    manifest: createModuleManifest({
      id: 'sf',
      version: '1.0.0',
      kind: 'strategy',
      name: 'Sandbox failure-mode strategy',
      summary: 'Structurally valid stub for sandbox failure-mode tests.',
      rationale: 'Exercises pre-Docker infrastructure failure paths.',
      hooks: ['onBarClose'],
      paramsSchema: { type: 'object' },
      capabilities: { platformSdk: true },
      dataNeeds: { closedCandlesUpToCurrent: true },
    }),
    entry: 'module.mjs',
    files: {
      'module.mjs': 'export function init() { return {}; } export function computeSignals() { return []; }',
    },
  };
}

async function statusOf(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  runId: string,
): Promise<RunStatusView> {
  return (await app.server.inject({ url: `/v1/runs/${runId}/status`, headers: AUTH })).json() as RunStatusView;
}

describe('sandbox failure modes (no Docker required)', () => {
  it('missing_module — bundle submitted but not present in the worker store', async () => {
    const sharedStore = new InMemoryJobStore();

    // App A: submits the run; bundle stored in its own InMemoryBundleStore.
    const submitApp = await buildTestApp(
      {},
      testDeps({ store: sharedStore, bundleStore: new InMemoryBundleStore() }),
    );
    try {
      const res = await submitApp.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'sf-missing', moduleBundle: minimalBundle() }),
      });
      expect(res.statusCode).toBe(202);
    } finally {
      await submitApp.dispose();
    }

    // App B: processes from the same job store but a *different*, empty bundle store.
    // sandboxBundleFor → bundleStore.get(hash) → undefined → RunnerError('missing_module').
    const processApp = await buildTestApp(
      {},
      testDeps({ store: sharedStore, bundleStore: new InMemoryBundleStore() }),
    );
    try {
      expect(await processApp.drain()).toBe(1);
      const s = await statusOf(processApp, 'sf-missing');
      expect(s.status).toBe('failed');
      expect(s.terminalCode).toBe('missing_module');
    } finally {
      await processApp.dispose();
    }
  });

  it('sandbox_module_error — executor receives null-source bundle (pre-Docker guard)', async () => {
    // processNextQueued makes two separate bundleStore.get() calls for a momentum job with a bundleHash:
    //   call 1 (sandboxBundleFor) — materializes the bundle to disk; needs real source.
    //   call 2 (executorFor)      — builds SandboxModuleExecutor; its computeSignals pre-check:
    //                               typeof files[entry] !== 'string' → RunnerError('sandbox_module_error').
    // Docker is never reached because the null-source guard fires first.
    const inner = new InMemoryBundleStore();
    let getCalls = 0;
    const splitGet: BundleStore = {
      put: (b) => inner.put(b),
      get: async (h) => {
        const real = await inner.get(h);
        if (!real) return undefined;
        getCalls++;
        if (getCalls <= 1) return real;
        // Return null source: passes the `in` key check but typeof null !== 'string'.
        return { ...real, files: { [real.entry]: null as unknown as string } };
      },
      has: (h) => inner.has(h),
    };

    const app = await buildTestApp({}, testDeps({ bundleStore: splitGet }));
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'sf-null-src', moduleBundle: minimalBundle() }),
      });
      expect(res.statusCode).toBe(202);
      expect(await app.drain()).toBe(1);
      const s = await statusOf(app, 'sf-null-src');
      expect(s.status).toBe('failed');
      expect(s.terminalCode).toBe('sandbox_module_error');
    } finally {
      await app.dispose();
    }
  });

  it('runner_failure — unexpected store error maps to generic terminal code', async () => {
    // put works (delegates to InMemoryBundleStore so the job is created with a bundleHash),
    // but get throws a plain Error — simulates an infrastructure outage during processing.
    // processNextQueued catch: err not instanceof RunnerError → code = 'runner_failure'.
    const inner = new InMemoryBundleStore();
    const failingGet: BundleStore = {
      put: (b) => inner.put(b),
      get: async () => {
        throw new Error('store temporarily unavailable');
      },
      has: (h) => inner.has(h),
    };

    const app = await buildTestApp({}, testDeps({ bundleStore: failingGet }));
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'sf-store-err', moduleBundle: minimalBundle() }),
      });
      expect(res.statusCode).toBe(202);
      expect(await app.drain()).toBe(1);
      const s = await statusOf(app, 'sf-store-err');
      expect(s.status).toBe('failed');
      expect(s.terminalCode).toBe('runner_failure');
    } finally {
      await app.dispose();
    }
  });
});
