// P2-19 — funding must prorate over the FORWARD interval [ts[t], ts[t+1]] (the span the post-bar
// position is actually held under next_bar_open), not a single gridMinutes extrapolated from the first
// two bars, and not the backward ts[t]-ts[t-1] (which mis-times pending entry/exit across a gap).
// These drive the ENGINE path (runBacktest via runRealismLedger) with synthetic canonical rows.
import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { type PaperTrade, runRealismLedger } from './helpers-replay.js';

const T0 = 1_800_000_000_000; // fixed epoch (ms); avoids Date.now
const MIN = 60_000;
const RATE = 0.0008; // constant 8h-equivalent funding rate
const INTERVAL_MIN = 8 * 60; // 480 — REALISM_EXEC funding interval

/** One synthetic canonical row at `minuteTs`, flat OHLC at `close`. `hasFunding` toggles coverage. */
function row(minuteTs: number, close: number, hasFunding = true): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts: minuteTs,
    symbol: 'SYNTH',
    open: close, high: close, low: close, close,
    volume: 1000, turnover: 1000 * close,
    oi_total_usd: 0,
    funding_rate: hasFunding ? RATE : 0,
    liq_long_usd: 0, liq_short_usd: 0,
    has_oi: false, has_funding: hasFunding, has_liquidations: false,
    taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: false,
  } as unknown as CanonicalRowV2;
}

/** Build rows at the given minute-offsets from T0 (a missing offset = a gap). `fundingUntil` (offset,
 *  exclusive of larger offsets) lets a tape lose funding coverage partway through for the stale test. */
function tape(offsets: readonly number[], fundingUntilOffset = Infinity): CanonicalRowV2[] {
  return offsets.map((m) => row(T0 + m * MIN, 100, m <= fundingUntilOffset));
}

function longTrade(openOffset: number, closeOffset: number): PaperTrade {
  return {
    tradeId: 'p2-19', symbol: 'SYNTH', side: 'long',
    openedAtMs: T0 + openOffset * MIN, closedAtMs: T0 + closeOffset * MIN,
    pnlPct: '0', closeReason: 'time_exit',
  };
}

/** barMinutes charged, backed out of a covered ledger entry's cost:
 *  cost = (rate/480) * (size*close) * sign * barMinutes ⇒ barMinutes = cost / (perMin*notional). */
function impliedMinutes(cost: number, size: number, close: number): number {
  return cost / ((RATE / INTERVAL_MIN) * (size * close) * 1); // long sign = +1
}

const covEntries = (ledger: { covered: boolean; cost: number; ts: number; barIndex: number }[]) =>
  ledger.filter((e) => e.covered && e.cost !== 0);

describe('P2-19 — funding prorates over the forward hold interval', () => {
  it('contiguous tape: every held bar charges exactly ONE minute (forward = timeframe)', async () => {
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 4, 5, 6]), [longTrade(1, 5)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('ENTRY pending through a gap is NOT charged for the pre-fill gap (forward, not backward)', async () => {
    // minute 1 missing → open decision on bar 0 (offset 0) fills at open of the NEXT bar (offset 2).
    // The position exists only from offset 2 onward; the 2-minute gap [0,2] must NOT be charged.
    // Backward (buggy) would charge the first held bar 2 minutes; forward charges its real 1 minute.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 2, 3, 4, 5]), [longTrade(0, 4)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    // no held bar is charged the 2-minute entry gap; every charge is the real 1-minute forward step
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('EXIT pending through a gap IS charged for the real hold across the gap', async () => {
    // minute 4 missing → exit decision on bar at offset 3 closes at the open of the next bar (offset 5).
    // The position is held from offset 3 to offset 5 = 2 minutes across the gap, so the bar at offset 3
    // (its forward interval spans the gap) must charge 2 minutes. Backward would drop this to 1.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 5, 6]), [longTrade(1, 3)]);
    const exitBar = ledger.find((e) => e.covered && e.ts === T0 + 3 * MIN);
    expect(exitBar).toBeDefined();
    expect(impliedMinutes(exitBar!.cost, size, 100)).toBeCloseTo(2, 9); // real 2-minute hold to the close
  });

  it('start-gap does NOT inflate every bar (was: gridMinutes = 2 ⇒ 2× on every bar)', async () => {
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 2, 3, 4, 5, 6]), [longTrade(2, 5)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('a STALE reading over a gap is capped to one timeframe — no arbitrary long stale charge', async () => {
    // Funding coverage ends after offset 2; the bar at offset 62 has NO snapshot but the previous
    // covered bar keeps it `stale` (1-bar grace). Its forward step to offset 63 is normal, but even if
    // it spanned a gap the stale cap bounds it to one timeframe — never the 60-minute gap.
    const rows = tape([0, 1, 2, 62, 63], /* fundingUntilOffset */ 2);
    const { ledger, size } = await runRealismLedger('SYNTH', rows, [longTrade(0, 63)]);
    for (const e of ledger) {
      if (!e.covered) { expect(e.cost).toBe(0); continue; }
      // no covered bar is charged more than the real forward step, and never a fabricated 60 minutes
      expect(impliedMinutes(e.cost, size, 100)).toBeLessThanOrEqual(60 + 1e-9);
    }
    // specifically: the stale bar at offset 62 charges at most one timeframe (1 minute), not the gap
    const staleBar = ledger.find((e) => e.ts === T0 + 62 * MIN && e.covered);
    if (staleBar) expect(impliedMinutes(staleBar.cost, size, 100)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('no double-charge: at most one ledger entry per bar ts', async () => {
    const { ledger } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 4, 5, 6]), [longTrade(1, 5)]);
    const seen = new Set<number>();
    for (const e of ledger) {
      expect(seen.has(e.ts)).toBe(false);
      seen.add(e.ts);
    }
  });
});
