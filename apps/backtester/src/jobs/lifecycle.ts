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

const ALLOWED_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  accepted: ['queued', 'canceled'],
  queued: ['running', 'canceled', 'expired'],
  running: ['completed', 'failed', 'canceled', 'timed_out', 'queued'],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
  timed_out: [],
};

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
