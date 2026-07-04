import { Client } from 'pg';
import { QUEUE_NOTIFY_CHANNEL } from './queue-notify-channel.js';

export interface QueueWaker {
  /** Resolve on the first of: a pending/incoming notification, the pollMs timeout, or signal abort. Never rejects. */
  waitForWake(pollMs: number, signal: AbortSignal): Promise<void>;
  /** Resolves once the LISTEN connection is established (timeout waker: resolves immediately). */
  whenReady(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Wait for `ms`, or resolve early if `signal` aborts. Removes its abort listener on BOTH exits so a
 * long-lived signal (the worker loop's) does not accumulate a listener per idle wait.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(t); cleanup(); resolve(); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/** Degraded waker: plain timeout. Used when the flag is off or the store is InMemory. */
export function createTimeoutWaker(): QueueWaker {
  return {
    waitForWake: (pollMs, signal) => sleep(pollMs, signal),
    whenReady: async () => {},
    dispose: async () => {},
  };
}

/**
 * Pg LISTEN waker. Owns ONE dedicated connection (a LISTEN connection is monopolized — never from the pool).
 * `pendingWake` closes the lost-wakeup window: a NOTIFY that lands between drains sets the flag, and the next
 * `waitForWake` returns immediately instead of sleeping. Reconnect is bounded; while disconnected the caller
 * still gets a plain `pollMs` timeout, so polling backstops correctness.
 */
export function createPgQueueWaker(connectionString: string): QueueWaker {
  let client: Client | undefined;
  let pendingWake = false;
  let wake: (() => void) | undefined; // resolves the in-flight waitForWake, if any
  let disposed = false;
  let markReady!: () => void;
  const readyOnce = new Promise<void>((res) => { markReady = res; }); // resolves on FIRST successful LISTEN

  const onNotify = (): void => { pendingWake = true; wake?.(); };

  const connect = async (forceWake: boolean): Promise<void> => {
    if (disposed) return;
    const c = new Client({ connectionString });
    c.on('notification', onNotify);
    c.on('error', () => { void reconnect(); });
    c.on('end', () => { if (!disposed) void reconnect(); });
    await c.connect();
    await c.query(`LISTEN ${QUEUE_NOTIFY_CHANNEL}`);
    client = c;
    markReady(); // whenReady() resolvers fire once; subsequent reconnects are no-ops on the promise
    // On RECONNECT only, force one re-drain: NOTIFYs emitted while the listener was down were missed.
    // On the INITIAL connect the worker loop's first drain already covers startup, so no forced wake —
    // keeping tests deterministic (nothing to drain before the real NOTIFY).
    if (forceWake) onNotify();
  };

  let backoffMs = 100;
  const reconnect = async (): Promise<void> => {
    if (disposed) return;
    try { await client?.end(); } catch { /* already gone */ }
    client = undefined;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 5_000);
    try { await connect(true); backoffMs = 100; } catch { void reconnect(); }
  };

  const started = connect(false).catch(() => { void reconnect(); });

  return {
    whenReady: () => readyOnce,
    async waitForWake(pollMs, signal) {
      await started;
      if (pendingWake) { pendingWake = false; return; }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => { wake = undefined; clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
        wake = done;
        const t = setTimeout(done, pollMs);
        signal.addEventListener('abort', done);
      });
      pendingWake = false;
    },
    async dispose() {
      disposed = true;
      wake?.();
      try { await client?.end(); } catch { /* already gone */ }
      client = undefined;
    },
  };
}
