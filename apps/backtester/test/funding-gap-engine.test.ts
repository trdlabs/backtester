// P2-19 — funding must prorate over the ACTUAL per-bar minute delta (ts[t] - ts[t-1]), not a single
// gridMinutes extrapolated from the first two bars. These drive the ENGINE path (runBacktest via
// runRealismLedger) with synthetic canonical rows so a mis-derived barMinutes is observable in the
// fundingLedger. Contiguous tapes must stay byte-identical; gap tapes must charge the real interval.
import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { type PaperTrade, runRealismLedger } from './helpers-replay.js';

const T0 = 1_800_000_000_000; // arbitrary fixed epoch (ms); avoids Date.now
const MIN = 60_000;
const RATE = 0.0008; // constant 8h-equivalent funding rate across the tape
const INTERVAL_MIN = 8 * 60; // 480 — REALISM_EXEC funding interval

/** One synthetic canonical row at `minuteTs`, funding-covered, flat OHLC at `close`. */
function row(minuteTs: number, close: number): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts: minuteTs,
    symbol: 'SYNTH',
    open: close, high: close, low: close, close,
    volume: 1000, turnover: 1000 * close,
    oi_total_usd: 0,
    funding_rate: RATE,
    liq_long_usd: 0, liq_short_usd: 0,
    has_oi: false, has_funding: true, has_liquidations: false,
    taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: false,
  } as unknown as CanonicalRowV2;
}

/** Build rows at the given minute-offsets from T0 (a missing offset = a gap in the tape). */
function tape(offsets: readonly number[]): CanonicalRowV2[] {
  return offsets.map((m) => row(T0 + m * MIN, 100));
}

/** A long PaperTrade opened at `openOffset` and closed at `closeOffset` (minute offsets from T0). */
function longTrade(openOffset: number, closeOffset: number): PaperTrade {
  return {
    tradeId: 'p2-19', symbol: 'SYNTH', side: 'long',
    openedAtMs: T0 + openOffset * MIN, closedAtMs: T0 + closeOffset * MIN,
    pnlPct: '0', closeReason: 'time_exit',
  };
}

/** Implied per-bar minutes charged, backed out of a covered ledger entry's cost:
 *  cost = (rate / 480) * (size * close) * sign * barMinutes  ⇒  barMinutes = cost / (perMinPerNotional). */
function impliedMinutes(cost: number, size: number, close: number): number {
  const perMinutePerNotional = (RATE / INTERVAL_MIN) * (size * close) * 1; // long sign = +1
  return cost / perMinutePerNotional;
}

describe('P2-19 — funding prorates over the actual per-bar minute delta', () => {
  it('contiguous tape: every held bar charges exactly ONE minute', async () => {
    // minutes 0..6 contiguous; open at 1 (fills at 2 under next_bar_open), close at 6.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 4, 5, 6]), [longTrade(1, 6)]);
    const covered = ledger.filter((e) => e.covered && e.cost !== 0);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) {
      expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
    }
  });

  it('gap at the START does NOT inflate every bar (was: gridMinutes = 2 ⇒ 2× on every bar)', async () => {
    // minute 1 missing → first two PRESENT bars are 0 and 2 (delta 2). The held bars all sit on the
    // contiguous tail (2,3,4,5,6), each 1 minute from its predecessor. Pre-fix: gridMinutes = (2-0) = 2
    // ⇒ every held bar charged 2 minutes. Fixed: each charges its real 1-minute delta.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 2, 3, 4, 5, 6]), [longTrade(2, 6)]);
    const covered = ledger.filter((e) => e.covered && e.cost !== 0);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) {
      expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9); // 1 minute, NOT the extrapolated 2
    }
  });

  it('gap in the MIDDLE while held charges the REAL interval, not a fixed gridMinutes', async () => {
    // minute 4 missing. Position held across it. The bar at minute 5 has predecessor minute 3 (4 is
    // absent) ⇒ real delta = 2 minutes. Pre-fix gridMinutes = (1-0) = 1 would undercharge it to 1 min.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 5, 6, 7]), [longTrade(1, 7)]);
    const gapBar = ledger.find((e) => e.covered && e.ts === T0 + 5 * MIN);
    expect(gapBar).toBeDefined();
    expect(impliedMinutes(gapBar!.cost, size, 100)).toBeCloseTo(2, 9); // real 2-minute hold across the gap
    // a normal contiguous held bar on the same run still charges exactly 1 minute
    const normalBar = ledger.find((e) => e.covered && e.ts === T0 + 3 * MIN);
    expect(impliedMinutes(normalBar!.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('no double-charge: exactly one ledger entry per held bar', async () => {
    const { ledger } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 4, 5, 6]), [longTrade(1, 6)]);
    const tsSeen = new Set<number>();
    for (const e of ledger) {
      expect(tsSeen.has(e.ts)).toBe(false); // each bar ts appears at most once
      tsSeen.add(e.ts);
    }
  });
});
