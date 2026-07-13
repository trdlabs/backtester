import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  BUNDLE_CONTRACT_VERSION,
  type ModuleBundle,
  type RunSubmitRequest,
} from '../src/contracts/index';
import type { Novelty } from '../src/contracts/run.js';
import type { WalkForward } from '../src/contracts/run.js';
import type { PromotionResult } from '../src/contracts/run.js';

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

  it('WalkForward union carries resolved / partial / unavailable shapes', () => {
    const agg = {
      foldCount: 2, metrics: {}, requestedFoldCount: 3, completedFoldCount: 2, insufficientFolds: [],
    };
    const resolved: WalkForward = {
      status: 'partial',
      scheme: { folds: 3, mode: 'rolling' },
      folds: [{ index: 0, train: { from: 'a', to: 'b' }, test: { from: 'b', to: 'c' }, foldOutcomeHash: 'h', metrics: { sharpe: 1 }, carryInClosedTradeCount: 0 }],
      aggregate: agg,
      failedFolds: [{ index: 2, code: 'sandbox_failure' }],
    };
    const none: WalkForward = {
      status: 'unavailable', scheme: { folds: 3, mode: 'rolling' }, reason: 'all_folds_failed',
      failedFolds: [{ index: 0, code: 'runner_failure' }], insufficientFolds: [],
    };
    expect(resolved.status).toBe('partial');
    expect(none.status).toBe('unavailable');
  });

  it('PromotionResult carries passed + not_qualified shapes with a single reason', () => {
    const passed: PromotionResult = { verdict: 'passed', evaluatedOn: 'holdout', attemptNumber: 3, evaluationWindow: { from: 'a', to: 'b' } };
    const failed: PromotionResult = { verdict: 'not_qualified', reason: 'holdout_not_covered', evaluatedOn: 'holdout' };
    expect(passed.verdict).toBe('passed');
    expect(failed.reason).toBe('holdout_not_covered');
  });
});
