import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, type InternalJobStatus } from '../src/jobs/lifecycle.js';

describe('coalescing lifecycle', () => {
  it('running <-> waiting_for_compute and waiting_for_compute -> queued/failed/canceled', () => {
    expect(canTransition('running', 'waiting_for_compute')).toBe(true);
    expect(canTransition('waiting_for_compute', 'queued')).toBe(true);
    expect(canTransition('waiting_for_compute', 'failed')).toBe(true);
    expect(canTransition('waiting_for_compute', 'canceled')).toBe(true);
    expect(canTransition('waiting_for_compute', 'completed')).toBe(false); // completes via queued->running->completed
  });
  it('waiting_for_compute is NOT terminal', () => {
    expect(isTerminal('waiting_for_compute' as InternalJobStatus)).toBe(false);
  });
});
