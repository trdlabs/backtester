// Pins concurrent-claim safety for the in-memory job store: when the parallel worker pool issues many
// concurrent claimNextQueued calls, each queued job is claimed by exactly one caller — no double-claim,
// no spurious giveaway. (Postgres handles this via FOR UPDATE SKIP LOCKED; this guards the in-memory CAS.)

import { describe, expect, it, afterEach } from 'vitest';
import { buildTestApp, runBody, AUTH } from './helpers.js';
import type { AppHandles } from '../src/app.js';

let app: AppHandles | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

describe('concurrent claimNextQueued (in-memory store)', () => {
  it('claims each queued job exactly once across many concurrent claimers', async () => {
    app = await buildTestApp();
    const N = 5;
    // Distinct seeds -> distinct request fingerprints -> N distinct queued jobs (no submit-dedup).
    for (let i = 0; i < N; i += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ seed: i }),
      });
      expect(res.statusCode).toBe(202);
    }

    // Fire more claimers than jobs, concurrently.
    const claims = await Promise.all(
      Array.from({ length: N * 3 }, () => app!.store.claimNextQueued(1_700_000_000_001)),
    );
    const claimedIds = claims.filter((j) => j !== undefined).map((j) => j!.runId);

    expect(claimedIds.length).toBe(N); // exactly N jobs claimed
    expect(new Set(claimedIds).size).toBe(N); // no job claimed twice
  });
});
