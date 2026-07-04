import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createPgQueueWaker, createTimeoutWaker } from '../src/jobs/queue-notify.js';
import { QUEUE_NOTIFY_CHANNEL } from '../src/jobs/queue-notify-channel.js';
import { PG_AVAILABLE } from './store-factories.js';

describe('createTimeoutWaker', () => {
  it('resolves on timeout', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    const t0 = Date.now();
    await w.waitForWake(30, ac.signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    await w.dispose();
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await w.waitForWake(10_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(200);
    await w.dispose();
  });

  it('resolves when the signal aborts mid-wait', async () => {
    const w = createTimeoutWaker();
    const ac = new AbortController();
    const p = w.waitForWake(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await p;
    expect(Date.now() - t0).toBeLessThan(500);
    await w.dispose();
  });
});

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
describe.skipIf(!PG_AVAILABLE)('createPgQueueWaker (Pg)', () => {
  it('wakes on NOTIFY well before the pollMs timeout', async () => {
    const w = createPgQueueWaker(PG_URL);
    const ac = new AbortController();
    await w.whenReady(); // LISTEN established; no initial forced wake to drain
    const notifier = new Client({ connectionString: PG_URL });
    await notifier.connect();
    const t0 = Date.now();
    const p = w.waitForWake(10_000, ac.signal);
    // Fire-and-forget: the NOTIFY reaches the waker's separate LISTEN socket independently of when this
    // query's own result comes back on the notifier's socket. Catch defensively so a benign race against
    // the `notifier.end()` below (connection closed just as this settles) can't surface as an unhandled
    // rejection — it does not affect the waker's wake-up semantics under test.
    setTimeout(() => void notifier.query(`SELECT pg_notify('${QUEUE_NOTIFY_CHANNEL}', '')`).catch(() => {}), 50);
    await p;
    expect(Date.now() - t0).toBeLessThan(2_000); // woke on NOTIFY, not the 10s poll
    await notifier.end();
    await w.dispose();
  });
});
