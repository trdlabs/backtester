import { describe, expect, it } from 'vitest';
import { ObsRegistry, type JobObsSample } from '../src/jobs/obs-registry.js';

const base: JobObsSample = {
  runId: 'r1', engine: 'momentum', outcome: 'completed',
  dedup: 'miss', queueWaitMs: 10, materializeMs: 40, engineMs: 100, totalMs: 150,
};

describe('ObsRegistry', () => {
  it('counts jobs by outcome and dedup class', () => {
    const reg = new ObsRegistry(1000);
    reg.recordJob(base);
    reg.recordJob({ ...base, runId: 'r2', outcome: 'failed', dedup: 'hit', engineMs: null });
    const s = reg.snapshot();
    expect(s.startedAtMs).toBe(1000);
    expect(s.jobs.total).toBe(2);
    expect(s.jobs.byOutcome).toEqual({ completed: 1, failed: 1 });
    expect(s.dedup.miss).toBe(1);
    expect(s.dedup.hit).toBe(1);
    expect(s.dedup.off).toBe(0);
  });

  it('folds count/sum/max per phase and skips null phase values', () => {
    const reg = new ObsRegistry(0);
    reg.recordJob({ ...base, queueWaitMs: 10, materializeMs: 40, engineMs: 100, totalMs: 150 });
    reg.recordJob({ ...base, runId: 'r2', dedup: 'hit', queueWaitMs: 20, materializeMs: 60, engineMs: null, totalMs: 90 });
    const s = reg.snapshot();
    expect(s.phases.queueWaitMs).toEqual({ count: 2, sum: 30, max: 20 });
    expect(s.phases.materializeMs).toEqual({ count: 2, sum: 100, max: 60 });
    expect(s.phases.engineMs).toEqual({ count: 1, sum: 100, max: 100 }); // hit's null engineMs skipped
    expect(s.phases.totalMs).toEqual({ count: 2, sum: 240, max: 150 });
  });
});
