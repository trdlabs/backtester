// Task 5 (result-dedup / coalescing) — JobRow/JobRowPatch coalescing fields + deferred-charge
// claimNextQueued. Coalescing OFF (no opts / opts.coalesceEnabled falsy) must charge `attempts`
// exactly as today (byte-for-byte, INV-5). Coalescing ON defers the attempts charge to the
// engine-commit path (Task 6/7) — claim only sets running + lease.

import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';

const CLOCK = 1_700_000_000_000;

const REQ = {
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
} as const;

function momentumJob(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: 'fp-momentum-shared',
    request: REQ as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

describe('deferred attempt charging on claim', () => {
  it('coalescing off: claim bumps attempts (unchanged)', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'run-x');
    const c = await store.claimNextQueued(1000, { workerId: 'w1', ttlMs: 100 });
    expect(c?.attempts).toBe(1);
  });

  it('coalescing on: claim sets running+lease but does NOT bump attempts', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'run-y');
    const c = await store.claimNextQueued(1000, { workerId: 'w1', ttlMs: 100 }, { coalesceEnabled: true });
    expect(c?.status).toBe('running');
    expect(c?.leasedBy).toBe('w1');
    expect(c?.attempts).toBe(0); // deferred to engine-commit (INV-5)
    expect(c?.computeWaitAttempts).toBe(0);
  });
});
