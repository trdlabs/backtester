// Task B5 — end-to-end dedup HIT confirmation: an inline bundle submit (X) that actually computes in
// the Docker sandbox, followed by a by-ref submit of the SAME bundle (bundleRef = bundleHash(X)). B1
// made requestFingerprint bundle-source-invariant (inline X and bundleRef=hash(X) share one identity),
// so the by-ref submit's computeIdentity collides with the inline run's and MUST be a dedup HIT —
// this test is the full-path confirmation, not a new mechanism.
//
// Docker + Pg gated: the inline run needs a real sandbox container (Docker) and the postgres store
// factory (Pg) to exercise the real worker/dedup path end-to-end. Skips cleanly (not fails) on a
// machine without a reachable Docker daemon or Postgres — e.g. WSL2 dev boxes — and runs in CI's
// Docker+Pg lane. B1's fingerprint-invariance golden (fingerprint-bundle-ref.test.ts) is the fast,
// always-run load-bearing gate; this is the slow confirmation that the full path actually behaves.
//
// result_hash is runId-stamped: the inline run (runId a) and the by-ref run (runId c) are DISTINCT
// runIds, so their result_hash values MUST differ even though the by-ref run is a cache HIT that never
// re-executes the engine. Do NOT assert equal result_hash across the two runs — assert dedup bookkeeping
// (dedupedFrom set, resultSummary re-stamped) instead.
import { describe, expect, it } from 'vitest';
import { PG_AVAILABLE, DOCKER_AVAILABLE, STORE_FACTORIES } from './store-factories.js';
import { AUTH, makeApp, makeBundle, runBody } from './helpers.js';
import { bundleHash } from '../src/sandbox/bundle.js';

const pgFactory = STORE_FACTORIES.find((f) => f.name === 'postgres')!;

describe.skipIf(!PG_AVAILABLE || !DOCKER_AVAILABLE)('bundle-ref dedup HIT', () => {
  it(
    'by-ref of an already-computed inline bundle is a dedup HIT (no engine, re-stamped runId)',
    async () => {
      const { app, store, cleanup } = await makeApp(pgFactory, {}, { dedupEnabled: true });
      try {
        // Same bundle used by sandbox.test.ts's real-sandbox-completion path: a valid strategy-kind
        // ModuleBundle whose signals() runs (and completes) inside the Docker harness. runBody() is
        // the shared default request (fixture dataset smoke-btc-1m, symbols BTCUSDT, seed 42) already
        // exercised by sandbox.test.ts / dedup-worker.test.ts over the exact same fixtures dir wired
        // into testConfig() — no bespoke request shape needed for the inline run to complete for real.
        const b = makeBundle();
        const post = (payload: object) =>
          app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });

        // Inline submit of bundle X — MISS: runs the sandboxed engine for real, populates the cache.
        const aRes = await post(runBody({ moduleBundle: b }));
        expect(aRes.statusCode).toBe(202);
        const a = aRes.json() as { runId: string };
        expect(await app.drain()).toBe(1); // compute + populate cache

        // By-ref submit of the SAME bundle content (bundleRef = bundleHash(X)) — same requestFingerprint
        // (B1 bundle-source invariance) ⇒ same computeIdentity ⇒ dedup HIT, no engine re-execution.
        const ref = bundleHash(b);
        const cRes = await post(runBody({ moduleBundle: undefined, bundleRef: ref }));
        expect(cRes.statusCode).toBe(202);
        const c = cRes.json() as { runId: string };
        expect(await app.drain()).toBe(1); // HIT path (no engine)

        const jobA = await store.get(a.runId);
        const jobC = await store.get(c.runId);
        expect(jobA?.status).toBe('completed');
        expect(jobC?.status).toBe('completed');

        // dedupedFrom is the resultCache computeIdentity that the HIT resolved against (worker.ts sets
        // `dedupedFrom = hit.computeIdentity`, NOT the source run's runId) — assert it is recorded, the
        // same convention every other dedup-HIT test in this repo uses (dedup-worker.test.ts,
        // coalesce-acceptance.test.ts: `expect(row?.dedupedFrom).toBeDefined()`).
        expect(jobC?.dedupedFrom).toBeDefined();
        // Re-stamped payload present — the HIT path re-stamps the cached template under runId c.
        expect(jobC?.resultSummary).toBeTruthy();
        // runId-stamped ⇒ MUST differ across two distinct runIds — never assert equal result_hash here.
        expect(jobC?.resultHash).toBeDefined();
        expect(jobC?.resultHash).not.toBe(jobA?.resultHash);
      } finally {
        await cleanup();
      }
    },
    60_000,
  );
});
