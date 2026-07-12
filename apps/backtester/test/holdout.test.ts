// E4a — pure held-out OOS module: window from coverage fraction, half-open overlap, marker.

import { describe, expect, it } from 'vitest';
import {
  buildHoldoutMarker,
  computeHoldoutWindow,
  HoldoutConfigError,
  holdoutOverlap,
} from '../src/engine/holdout.js';

// 10-day coverage ⇒ fraction 0.2 ⇒ holdout = last 2 days [01-09, 01-11).
const COVERAGE = { from: '2023-01-01T00:00:00.000Z', to: '2023-01-11T00:00:00.000Z' };
const HOLDOUT = { from: '2023-01-09T00:00:00.000Z', to: '2023-01-11T00:00:00.000Z' };

describe('computeHoldoutWindow', () => {
  it('carves the last `fraction` of the coverage span', () => {
    expect(computeHoldoutWindow(COVERAGE, 0.2)).toEqual(HOLDOUT);
  });
  it('the window ends exactly at coverage `to`', () => {
    expect(computeHoldoutWindow(COVERAGE, 0.5).to).toBe(COVERAGE.to);
  });
  for (const bad of [0, 1, -0.1, 1.5, Number.NaN]) {
    it(`fail-fast on fraction ${bad}`, () => {
      expect(() => computeHoldoutWindow(COVERAGE, bad)).toThrow(HoldoutConfigError);
    });
  }
  it('fail-fast on coverage from >= to', () => {
    expect(() => computeHoldoutWindow({ from: COVERAGE.to, to: COVERAGE.from }, 0.2)).toThrow(HoldoutConfigError);
  });
  it('fail-fast on unparseable coverage', () => {
    expect(() => computeHoldoutWindow({ from: 'x', to: COVERAGE.to }, 0.2)).toThrow(HoldoutConfigError);
  });
});

describe('holdoutOverlap (half-open [from, to))', () => {
  it('run fully inside ⇒ overlaps, containment full', () => {
    expect(holdoutOverlap({ from: '2023-01-09T12:00:00.000Z', to: '2023-01-10T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: true,
      containment: 'full',
    });
  });
  it('run straddling the start ⇒ partial', () => {
    expect(holdoutOverlap({ from: '2023-01-08T00:00:00.000Z', to: '2023-01-10T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: true,
      containment: 'partial',
    });
  });
  it('run wider than the holdout ⇒ partial (not full)', () => {
    expect(holdoutOverlap({ from: '2023-01-08T00:00:00.000Z', to: '2023-01-12T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: true,
      containment: 'partial',
    });
  });
  it('run entirely before ⇒ none', () => {
    expect(holdoutOverlap({ from: '2023-01-05T00:00:00.000Z', to: '2023-01-08T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: false,
      containment: 'none',
    });
  });
  it('run entirely after ⇒ none', () => {
    expect(holdoutOverlap({ from: '2023-01-11T00:00:00.000Z', to: '2023-01-12T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: false,
      containment: 'none',
    });
  });
  it('boundary touch (run.to === holdout.from) is NOT overlap', () => {
    expect(holdoutOverlap({ from: '2023-01-07T00:00:00.000Z', to: '2023-01-09T00:00:00.000Z' }, HOLDOUT)).toEqual({
      overlaps: false,
      containment: 'none',
    });
  });
});

describe('buildHoldoutMarker', () => {
  it('returns a provenance-bearing resolved marker', () => {
    const m = buildHoldoutMarker(COVERAGE, 0.2, { from: '2023-01-09T12:00:00.000Z', to: '2023-01-10T00:00:00.000Z' });
    expect(m).toEqual({
      status: 'resolved',
      policy: 'coverage_fraction',
      fraction: 0.2,
      coverage: COVERAGE,
      window: HOLDOUT,
      overlaps: true,
      containment: 'full',
    });
  });
});
