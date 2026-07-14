// P2-19 — funding cadence must come from the SERVER-validated dataset timeframe (one snapshot per bar),
// NOT inferred from observed bar gaps, and each covered bar realizes exactly ONE cadence period. A gap
// must never be extrapolated at a single rate. These drive the ENGINE path (runBacktest via
// runRealismLedger) with synthetic canonical rows on a 1m tape (cadence = 1 minute).
import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { type PaperTrade, runRealismLedger } from './helpers-replay.js';

const T0 = 1_800_000_000_000; // fixed epoch (ms); avoids Date.now
const MIN = 60_000;
const RATE = 0.0008; // constant 8h-equivalent funding rate
const INTERVAL_MIN = 8 * 60; // 480 — REALISM_EXEC funding interval

/** One synthetic 1m canonical row at `minuteTs`, flat OHLC at `close`. `hasFunding` toggles coverage. */
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

/** Rows at the given minute-offsets from T0 (a missing offset = a gap). `fundingUntilOffset` lets a tape
 *  lose funding coverage partway through (offsets beyond it carry has_funding=false) for the stale test. */
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

/** Minutes charged, backed out of a covered ledger entry's cost:
 *  cost = (rate/480) * (size*close) * sign * barMinutes ⇒ barMinutes = cost / (perMin*notional). */
function impliedMinutes(cost: number, size: number, close: number): number {
  return cost / ((RATE / INTERVAL_MIN) * (size * close) * 1); // long sign = +1
}

const covEntries = (ledger: { covered: boolean; cost: number; ts: number }[]) =>
  ledger.filter((e) => e.covered && e.cost !== 0);

describe('P2-19 — funding charges one server-cadence period per covered bar', () => {
  it('contiguous 1m tape: every held bar charges exactly ONE minute', async () => {
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 4, 5, 6]), [longTrade(1, 5)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('start-gap does NOT inflate every bar (was: gridMinutes = 2 ⇒ 2× on every bar)', async () => {
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 2, 3, 4, 5, 6]), [longTrade(2, 5)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('ENTRY pending through a gap is not charged for the pre-fill gap — held bars charge one cadence', async () => {
    // minute 1 missing → open decision on bar 0 fills at the open of the next bar (offset 2); the
    // position exists only from offset 2 and each held bar charges 1 minute, never the 2-minute gap.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 2, 3, 4, 5]), [longTrade(0, 4)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) expect(impliedMinutes(e.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('EXIT pending through a gap charges one cadence per snapshot, not the extrapolated gap span', async () => {
    // minute 4 missing → exit decision on the bar at offset 3 closes at the next bar (offset 5). The
    // bar at offset 3 realizes its single snapshot = 1 minute; the missing gap minute has no snapshot.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3, 5, 6]), [longTrade(1, 3)]);
    const exitBar = ledger.find((e) => e.covered && e.ts === T0 + 3 * MIN)!;
    expect(exitBar).toBeDefined();
    expect(impliedMinutes(exitBar.cost, size, 100)).toBeCloseTo(1, 9);
  });

  it('sparse 1m tape [0, 60] with entry on the final bar charges 1 minute, NOT 60 (server cadence, not min-gap)', async () => {
    // Two bars 60 minutes apart on a 1m tape. Open decision on bar 0 fills at open(bar 60) and is
    // force-closed at its close — the position was held one real 1-minute candle. Inferring the
    // timeframe from the observed 60-minute gap (the old min-gap logic) would wrongly charge 60 minutes.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 60]), [longTrade(0, 9999)]);
    const covered = covEntries(ledger);
    expect(covered.length).toBe(1); // exactly the final held bar
    expect(impliedMinutes(covered[0].cost, size, 100)).toBeCloseTo(1, 9); // 1 minute, not 60
  });

  it('present bar before a coverage gap charges ONE minute, not the whole gap (freshness bounds the interval)', async () => {
    // Funding coverage ends after offset 2, then a 60-minute jump to offset 62. The present bar at
    // offset 2 must charge only its single cadence period (1 min) — never live-forward the last rate
    // across the 60-minute gap. The stale bar at offset 62 (1-bar grace) also charges just 1 minute,
    // and the bar at offset 63 (past grace) charges 0.
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 62, 63], /* fundingUntil */ 2), [longTrade(0, 9999)]);
    const at = (off: number) => ledger.find((e) => e.ts === T0 + off * MIN)!;
    const presentBar = at(2);
    expect(presentBar).toBeDefined();
    expect(presentBar.covered).toBe(true);
    expect(impliedMinutes(presentBar.cost, size, 100)).toBeCloseTo(1, 9); // NOT 60

    // The bar at offset 62 sits 60 minutes after the last covered snapshot (offset 2). Elapsed-aware
    // freshness (age > FUNDING_STALE_GRACE_BARS × cadence) rejects it — an arbitrarily-old rate must not
    // resurrect after a gap just because 62 is the next PROCESSED bar. So it is uncovered ⇒ 0.
    const afterGapBar = at(62);
    expect(afterGapBar).toBeDefined();
    expect(afterGapBar.covered).toBe(false);
    expect(afterGapBar.cost).toBe(0);

    const beyondGrace = at(63);
    expect(beyondGrace).toBeDefined();
    expect(beyondGrace.covered).toBe(false);
    expect(beyondGrace.cost).toBe(0);
  });

  it('adjacent missing bar within one cadence IS the allowed one-bar stale grace (charges one cadence)', async () => {
    // Coverage ends after offset 2; the very next bar (offset 3) is one cadence later, so the offset-2
    // snapshot is stale WITHIN grace by elapsed time and charges exactly one cadence — pinning the
    // permitted grace (contrast the 60-minute gap above, which is rejected).
    const { ledger, size } = await runRealismLedger('SYNTH', tape([0, 1, 2, 3], /* fundingUntil */ 2), [longTrade(0, 9999)]);
    const staleBar = ledger.find((e) => e.ts === T0 + 3 * MIN)!;
    expect(staleBar).toBeDefined();
    expect(staleBar.covered).toBe(true);
    expect(impliedMinutes(staleBar.cost, size, 100)).toBeCloseTo(1, 9);
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
