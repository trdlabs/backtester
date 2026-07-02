// Job lifecycle — 8 states, 5 terminal. Lifted from trading-platform 031 (mcp-gateway/jobs/lifecycle).

import type { RunStatus } from '@trading/research-contracts';

export const NON_TERMINAL: readonly RunStatus[] = ['accepted', 'queued', 'running'];
export const TERMINAL: readonly RunStatus[] = [
  'completed',
  'failed',
  'canceled',
  'expired',
  'timed_out',
];

// Internal-only status (INV-7): a coalescing follower is 'waiting_for_compute' inside the
// backtester, but NEVER part of the public @trading/research-contracts RunStatus. toStatusView
// projects it back to 'running' for anything that crosses the public contract boundary.
export type InternalJobStatus = RunStatus | 'waiting_for_compute';

const ALLOWED_TRANSITIONS: Record<InternalJobStatus, readonly InternalJobStatus[]> = {
  accepted: ['queued', 'canceled'],
  queued: ['running', 'canceled', 'expired'],
  running: ['completed', 'failed', 'canceled', 'timed_out', 'queued', 'waiting_for_compute'],
  waiting_for_compute: ['queued', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
  timed_out: [],
};

export function isTerminal(status: InternalJobStatus): boolean {
  return TERMINAL.includes(status as RunStatus);
}

export function canTransition(from: InternalJobStatus, to: InternalJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
