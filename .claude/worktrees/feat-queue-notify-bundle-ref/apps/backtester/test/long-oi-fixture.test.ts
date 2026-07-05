import { describe, expect, it } from 'vitest';
import { toFixtureFile, fixtureWindow } from '../scripts/lib/long-oi-fixture.mjs';

const SAMPLE = {
  rowsBySymbol: {
    BBB: [
      { schema_version: 2, symbol: 'BBB', minute_ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 0, turnover: 0, oi_total_usd: 5, funding_rate: 0, liq_long_usd: 0, liq_short_usd: 0, has_oi: true, has_funding: true, has_liquidations: true, taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: true },
    ],
    AAA: [
      { schema_version: 2, symbol: 'AAA', minute_ts: 60000, open: 2, high: 2, low: 2, close: 2, volume: 0, turnover: 0, oi_total_usd: 9, funding_rate: 0, liq_long_usd: 0, liq_short_usd: 0, has_oi: true, has_funding: true, has_liquidations: true, taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: true },
    ],
  },
};

describe('long-oi fixture converter', () => {
  it('flattens rowsBySymbol into a single rows array preserving fields', () => {
    const f = toFixtureFile(SAMPLE as never, 'long-oi-3sym-1m', '1m');
    expect(f.datasetRef).toBe('long-oi-3sym-1m');
    expect(f.timeframe).toBe('1m');
    expect(f.rows).toHaveLength(2);
    expect(f.rows.every((r) => typeof r.oi_total_usd === 'number' && r.has_oi === true)).toBe(true);
  });

  it('computes window [minTs, maxTs+60s) and sorted unique symbols', () => {
    const w = fixtureWindow(toFixtureFile(SAMPLE as never, 'x', '1m').rows);
    expect(w.fromMs).toBe(1000);
    expect(w.toMs).toBe(60000 + 60000);
    expect(w.symbols).toEqual(['AAA', 'BBB']);
  });
});
