// Unit tests for submit.ts::submitRun — bundleRef (by-hash) bundle-source resolution (Task B2).
// TDD: written before the implementation change (RED first).
// Run: pnpm test submit-bundle-ref

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { submitRun, type SubmitDeps } from '../src/jobs/submit.js';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store.js';
import { bundleHash } from '../src/sandbox/bundle.js';
import { makeBundle, runBody } from './helpers.js';

function deps(): SubmitDeps {
  return {
    store: new InMemoryJobStore(), bundleStore: new InMemoryBundleStore(),
    clock: () => 1_000_000, uid: () => randomUUID(),
    defaultQueueTimeoutMs: 60_000, defaultRunTimeoutMs: 300_000, enableOverlayEngine: true,
  };
}

describe('submitRun bundleRef', () => {
  it('rejects both moduleBundle and bundleRef (400)', async () => {
    const b = makeBundle();
    await expect(submitRun(deps(), runBody({ moduleBundle: b, bundleRef: bundleHash(b) }) as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });
  it('rejects a malformed bundleRef (400)', async () => {
    await expect(submitRun(deps(), runBody({ moduleBundle: undefined, bundleRef: 'not-a-hash' as never }) as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });
  it('rejects an unknown bundleRef (409 unknown_bundle)', async () => {
    await expect(submitRun(deps(), runBody({ moduleBundle: undefined, bundleRef: bundleHash(makeBundle()) }) as never))
      .rejects.toMatchObject({ statusCode: 409, code: 'unknown_bundle' });
  });
  it('accepts a known bundleRef without re-uploading', async () => {
    const d = deps();
    const hash = await d.bundleStore!.put(makeBundle());
    const out = await submitRun(d, runBody({ moduleBundle: undefined, bundleRef: hash }) as never);
    expect(out.created).toBe(true);
    const job = await d.store.get(out.handle.runId);
    expect(job?.bundleHash).toBe(hash);
    expect((job?.request as { bundleRef?: string }).bundleRef).toBeUndefined(); // stripped
  });
});
