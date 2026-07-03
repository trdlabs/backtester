// Optional worker health server (Kubernetes probes). Workers do not serve /v1; this is a tiny,
// isolated node:http listener. Liveness stays up during graceful drain; readiness drops on SIGTERM.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { boundedErrorDetail } from './bounded-error-detail.js';

export interface WorkerHealthState {
  /** true while the process is alive and the drain loop has not fully resolved. */
  live(): boolean;
  /** true while the worker is accepting work (drops to false on SIGTERM/drain). */
  ready(): boolean;
}

export interface StatsProvider {
  snapshot(): unknown;
}

export type QueueStatsProvider = (nowMs: number) => Promise<{ depth: number; oldestQueuedAgeMs: number | null }>;

export async function startWorkerHealthServer(
  port: number,
  state: WorkerHealthState,
  stats?: StatsProvider,
  queueStats?: QueueStatsProvider,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.live() ? 200 : 503).end();
    } else if (req.url === '/readyz') {
      res.writeHead(state.ready() ? 200 : 503).end();
    } else if (req.url === '/statsz') {
      if (stats) {
        const base = stats.snapshot() as Record<string, unknown>;
        void (async () => {
          let queue: unknown;
          if (queueStats) {
            try {
              queue = await queueStats(Date.now());
            } catch (err) {
              queue = { error: boundedErrorDetail(err) };
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(queue === undefined ? base : { ...base, queue }));
        })();
      } else {
        res.writeHead(404).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close keep-alive sockets (Node's global fetch/undici holds them) so close() resolves
        // promptly instead of blocking on keepAliveTimeout.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
