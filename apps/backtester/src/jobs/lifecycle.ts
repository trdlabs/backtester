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
  // 'expired' (P2-5): a job crashed mid-submit — insertOrGet(accepted) committed but the follow-up
  // transition to 'queued' never ran — stays 'accepted' forever. The queue-deadline reaper expires it
  // in place, so this edge must be allowed (InMemory transition goes through canTransition).
  accepted: ['queued', 'canceled', 'expired'],
  queued: ['running', 'canceled', 'expired'],
  // 'running' -> 'running' is a deliberate self-transition: the coalescing engine-commit charge
  // (worker.ts::chargeEngineAttempt) persists `attempts`/`engineAttemptCharged` via a same-status
  // transition (no status change, only a JobRowPatch write) before the engine runs. Without this,
  // that write is rejected by canTransition and the deferred attempts++ charge is silently lost.
  running: ['running', 'completed', 'failed', 'canceled', 'timed_out', 'queued', 'waiting_for_compute'],
  // 'timed_out' added (P1-3): the run-deadline reaper is a parked follower's ONLY backstop when the
  // coalescing flag is rolled back (wakeComputeWaiters is flag-gated) — without it, a follower strands.
  waiting_for_compute: ['queued', 'failed', 'canceled', 'timed_out'],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
  timed_out: [],
};

export function isTerminal(status: InternalJobStatus): boolean {
  return TERMINAL.includes(status as RunStatus);
}

// INV-7: waiting_for_compute is internal-only and must never cross the public contract boundary.
// Every site that serializes a job's status into a public HTTP/contract shape MUST route through
// this projection (toStatusView and the /result 409 fallback both do).
export function publicStatus(status: InternalJobStatus): RunStatus {
  return status === 'waiting_for_compute' ? 'running' : status;
}

export function canTransition(from: InternalJobStatus, to: InternalJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
