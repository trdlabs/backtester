import { describe, expect, it } from 'vitest';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { RUNID_SENTINEL } from '../src/jobs/dedup/version';

// A payload with runId woven top-level, nested, and DERIVED (`${runId}::variant`) — mirrors the
// real engine footprint (runner.ts baseline/variant + metrics).
function payload(runId: string): unknown {
  return {
    runId,
    runKind: 'baseline-vs-variant',
    metrics: { sharpe: 1.5 },
    variants: [
      { kind: 'baseline', runId, note: 'x' },
      { kind: 'variant', runId: `${runId}::variant`, note: 'y' },
    ],
    evidence: { seed: 7, moduleVersions: [{ id: 'm', version: '1.0.0' }] },
  };
}

describe('normalize/restamp', () => {
  it('normalize erases runId everywhere including derived forms', () => {
    const t = normalize('overlay', payload('run-AAA'), 'run-AAA');
    expect(JSON.stringify(t.normalizedPayload)).not.toContain('run-AAA');
    expect(JSON.stringify(t.normalizedPayload)).toContain(RUNID_SENTINEL);
    expect(JSON.stringify(t.normalizedPayload)).toContain(`${RUNID_SENTINEL}::variant`);
    expect(t.engine).toBe('overlay');
    expect(t.payloadKind).toBe('RunOutcome');
  });

  it('normalize of two runs (different runId) is identical', () => {
    const a = normalize('overlay', payload('run-AAA'), 'run-AAA').normalizedPayload;
    const b = normalize('overlay', payload('run-BBB'), 'run-BBB').normalizedPayload;
    expect(a).toEqual(b);
  });

  it('restamp is the exact inverse: restamp(normalize(p(X),X), Y) deep-equals p(Y)', () => {
    const t = normalize('overlay', payload('run-AAA'), 'run-AAA');
    expect(restamp(t, 'run-BBB')).toEqual(payload('run-BBB'));
  });

  it('momentum payloadKind is BacktestResult', () => {
    expect(normalize('momentum', payload('r'), 'r').payloadKind).toBe('BacktestResult');
  });
});
