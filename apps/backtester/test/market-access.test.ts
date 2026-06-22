// Characterization tests for pointInTimeMarketApi — the 023/030 point-in-time market surface
// (US1, FR-006/008-011, R3/R6). Coverage flagged market-access.ts at ~2%. Pure projection over a
// materialized tape; pins the structural no-lookahead window math, the covered-0/0-vs-gap
// distinction (no carry-forward), funding stale-grace (R6), taker exactness, and composition-
// following (methods present only when the tape carries that kind). No source change.

import { describe, expect, it } from 'vitest';
import type {
  FundingSnapshot,
  LiquidationSnapshot,
  MarketTapeDataset,
  MinuteColumn,
  OpenInterestSnapshot,
  TakerSnapshot,
} from '@trading/research-contracts/research';
import { pointInTimeMarketApi } from '../src/engine/market-access';

const GRID = [100, 101, 102, 103];

// MinuteColumn backed by a ts→snapshot map; `covered` defaults to the snapshot minutes but can be
// narrowed (used to drive the funding present/stale/missing distinction).
const col = <T extends { ts: number }>(
  snaps: readonly T[],
  coveredTs: readonly number[] = snaps.map((s) => s.ts),
): MinuteColumn<T> => {
  const byTs = new Map<number, T>(snaps.map((s) => [s.ts, s]));
  const cov = new Set(coveredTs);
  return { at: (ts) => byTs.get(ts), covered: (ts) => cov.has(ts) };
};

interface Cols {
  oi?: MinuteColumn<OpenInterestSnapshot>;
  liq?: MinuteColumn<LiquidationSnapshot>;
  funding?: MinuteColumn<FundingSnapshot>;
  taker?: MinuteColumn<TakerSnapshot>;
}

const dataset = (cols: Cols, grid: readonly number[] = GRID): MarketTapeDataset =>
  ({
    datasetRef: 'ds',
    timeframe: '1m',
    symbols: () => ['BTCUSDT'],
    candles: () => grid.map((ts) => ({ ts, open: 0, high: 0, low: 0, close: 0, volume: 0 })),
    openInterest: () => cols.oi,
    liquidations: () => cols.liq,
    funding: () => cols.funding,
    taker: () => cols.taker,
  }) as unknown as MarketTapeDataset;

const api = (cols: Cols, t: number) => pointInTimeMarketApi(dataset(cols), 'BTCUSDT', t);

describe('market-access — OI as-of + window', () => {
  // present at 100/102, present-zero at 103, gap at 101
  const oi = col<OpenInterestSnapshot>([
    { ts: 100, oiTotalUsd: 1000 },
    { ts: 102, oiTotalUsd: 1200 },
    { ts: 103, oiTotalUsd: 0 },
  ]);

  it('oiAsOf returns the snapshot at t', () => {
    expect(api({ oi }, 102).oiAsOf()).toEqual({ ts: 102, oiTotalUsd: 1200 });
  });

  it('oiAsOf returns undefined on a gap (no carry-forward)', () => {
    expect(api({ oi }, 101).oiAsOf()).toBeUndefined();
  });

  it('oiAsOf keeps a covered 0 as a real point (0 ≠ gap)', () => {
    expect(api({ oi }, 103).oiAsOf()).toEqual({ ts: 103, oiTotalUsd: 0 });
  });

  it('oiWindow ends at t inclusive and leaves gaps as explicit undefined', () => {
    expect(api({ oi }, 102).oiWindow(3)).toEqual([{ ts: 100, oiTotalUsd: 1000 }, undefined, { ts: 102, oiTotalUsd: 1200 }]);
  });
});

describe('market-access — liquidations as-of', () => {
  const liq = col<LiquidationSnapshot>([
    { ts: 102, longUsd: 50, shortUsd: 20 },
    { ts: 103, longUsd: 0, shortUsd: 0 },
  ]);

  it('liqAsOf returns the snapshot at t (incl. covered {0,0})', () => {
    expect(api({ liq }, 102).liqAsOf()).toEqual({ ts: 102, longUsd: 50, shortUsd: 20 });
    expect(api({ liq }, 103).liqAsOf()).toEqual({ ts: 103, longUsd: 0, shortUsd: 0 });
  });

  it('liqAsOf is undefined on a gap', () => {
    expect(api({ liq }, 100).liqAsOf()).toBeUndefined();
  });
});

describe('market-access — window math (windowMinutes)', () => {
  const oi = col<OpenInterestSnapshot>(GRID.map((ts) => ({ ts, oiTotalUsd: ts })));

  it('an invalid lookback (≤0 or non-integer) yields an empty window', () => {
    expect(api({ oi }, 102).oiWindow(0)).toEqual([]);
    expect(api({ oi }, 102).oiWindow(-1)).toEqual([]);
    expect(api({ oi }, 102).oiWindow(2.5)).toEqual([]);
  });

  it('a lookback larger than available is truncated to [0..t]', () => {
    // t=101 (idx 1), lookback 5 → start clamps to 0 → [100,101]
    expect(api({ oi }, 101).oiWindow(5)).toEqual([{ ts: 100, oiTotalUsd: 100 }, { ts: 101, oiTotalUsd: 101 }]);
  });

  it('a t outside the grid (idx<0) yields undefined as-of and an empty window', () => {
    expect(api({ oi }, 999).oiAsOf()).toBeUndefined();
    expect(api({ oi }, 999).oiWindow(3)).toEqual([]);
  });
});

describe('market-access — funding stale-grace (R6, grace=1)', () => {
  // snapshots at 100/101/102 (103 gap); only minute 100 is covered.
  const funding = col<FundingSnapshot>(
    [
      { ts: 100, fundingRate: 0.01 },
      { ts: 101, fundingRate: 0.01 },
      { ts: 102, fundingRate: 0.01 },
    ],
    [100],
  );

  it('present when the minute itself is funding-covered', () => {
    expect(api({ funding }, 100).fundingAsOf?.()).toEqual({ state: 'present', point: { ts: 100, fundingRate: 0.01 } });
  });

  it('stale when uncovered but within grace of a covered prior minute (bounded live-forward)', () => {
    expect(api({ funding }, 101).fundingAsOf?.()).toEqual({ state: 'stale', point: { ts: 101, fundingRate: 0.01 } });
  });

  it('missing when beyond grace (no covered minute within 1 bar back)', () => {
    expect(api({ funding }, 102).fundingAsOf?.()).toEqual({ state: 'missing' });
  });

  it('missing when there is no snapshot at all', () => {
    expect(api({ funding }, 103).fundingAsOf?.()).toEqual({ state: 'missing' });
  });

  it('fundingWindow is per-minute as-of (present/stale carry the point, missing → undefined)', () => {
    expect(api({ funding }, 102).fundingWindow?.(3)).toEqual([
      { ts: 100, fundingRate: 0.01 },
      { ts: 101, fundingRate: 0.01 },
      undefined,
    ]);
  });
});

describe('market-access — taker exactness (no carry-forward, present-zero)', () => {
  const taker = col<TakerSnapshot>([
    { ts: 101, buyUsd: 0, sellUsd: 0 },
    { ts: 102, buyUsd: 5, sellUsd: 3 },
  ]);

  it('present at a bucket (incl. present-zero {0,0})', () => {
    expect(api({ taker }, 102).takerAsOf?.()).toEqual({ state: 'present', point: { ts: 102, buyUsd: 5, sellUsd: 3 } });
    expect(api({ taker }, 101).takerAsOf?.()).toEqual({ state: 'present', point: { ts: 101, buyUsd: 0, sellUsd: 0 } });
  });

  it('missing on a gap (no carry-forward, not zero)', () => {
    expect(api({ taker }, 100).takerAsOf?.()).toEqual({ state: 'missing' });
  });

  it('takerWindow is exact per-minute (gap → undefined)', () => {
    expect(api({ taker }, 102).takerWindow?.(3)).toEqual([undefined, { ts: 101, buyUsd: 0, sellUsd: 0 }, { ts: 102, buyUsd: 5, sellUsd: 3 }]);
  });
});

describe('market-access — composition-following + immutability', () => {
  it('omits funding/taker methods when the tape does not carry those kinds (SC-004)', () => {
    const surface = api({ oi: col<OpenInterestSnapshot>([{ ts: 100, oiTotalUsd: 1 }]) }, 100);
    expect('oiAsOf' in surface).toBe(true);
    expect('fundingAsOf' in surface).toBe(false);
    expect('fundingWindow' in surface).toBe(false);
    expect('takerAsOf' in surface).toBe(false);
    expect('takerWindow' in surface).toBe(false);
  });

  it('exposes funding/taker methods when the tape carries those kinds', () => {
    const surface = api(
      { funding: col<FundingSnapshot>([{ ts: 100, fundingRate: 0.01 }]), taker: col<TakerSnapshot>([{ ts: 100, buyUsd: 1, sellUsd: 1 }]) },
      100,
    );
    expect('fundingAsOf' in surface).toBe(true);
    expect('takerAsOf' in surface).toBe(true);
  });

  it('returns a deep-frozen surface', () => {
    expect(Object.isFrozen(api({ oi: col<OpenInterestSnapshot>([{ ts: 100, oiTotalUsd: 1 }]) }, 100))).toBe(true);
  });

  it('oiWindow/liqWindow are empty when the kind is absent', () => {
    const surface = api({}, 100);
    expect(surface.oiWindow(3)).toEqual([]);
    expect(surface.liqWindow(3)).toEqual([]);
    expect(surface.oiAsOf()).toBeUndefined();
    expect(surface.liqAsOf()).toBeUndefined();
  });
});
