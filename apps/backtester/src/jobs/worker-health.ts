// Optional worker health server (Kubernetes probes). Workers do not serve /v1; this is a tiny,
// isolated node:http listener. Liveness stays up during graceful drain; readiness drops on SIGTERM.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface WorkerHealthState {
  /** true while the process is alive and the drain loop has not fully resolved. */
  live(): boolean;
  /** true while the worker is accepting work (drops to false on SIGTERM/drain). */
  ready(): boolean;
}

export interface StatsProvider {
  snapshot(): unknown;
}

export async function startWorkerHealthServer(
  port: number,
  state: WorkerHealthState,
  stats?: StatsProvider,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.live() ? 200 : 503).end();
    } else if (req.url === '/readyz') {
      res.writeHead(state.ready() ? 200 : 503).end();
    } else if (req.url === '/statsz') {
      if (stats) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats.snapshot()));
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
