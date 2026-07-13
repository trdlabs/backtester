import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  BUNDLE_CONTRACT_VERSION,
  type ModuleBundle,
  type RunSubmitRequest,
} from '../src/contracts/index';
import type { Novelty } from '../src/contracts/run.js';

describe('public contracts', () => {
  it('pins the current contract versions', () => {
    expect(API_CONTRACT_VERSION).toBe('017.2');
    expect(BUNDLE_CONTRACT_VERSION).toBe('019.1');
    expect(ARTIFACT_CONTRACT_VERSION).toBe('022.2');
  });

  it('types submitted bundles and runs', () => {
    expectTypeOf<RunSubmitRequest['moduleBundle']>()
      .toEqualTypeOf<ModuleBundle | undefined>();
  });

  it('Novelty union carries resolved + no_comparators shapes', () => {
    const resolved: Novelty = {
      status: 'resolved',
      score: 0.3,
      maxAbsCorrelation: 0.7,
      nearest: { ref: 'h1', runId: 'r1', correlation: 0.7, overlapDays: 40 },
      comparabilityKey: 'k',
      comparedAgainst: 2,
      behavioralDuplicate: false,
      policy: { threshold: 0.8, minOverlapDays: 30 },
    };
    const none: Novelty = {
      status: 'no_comparators',
      reason: 'empty_pool',
      comparabilityKey: 'k',
      policy: { threshold: 0.8, minOverlapDays: 30 },
    };
    expect(resolved.status).toBe('resolved');
    expect(none.status).toBe('no_comparators');
  });
});
