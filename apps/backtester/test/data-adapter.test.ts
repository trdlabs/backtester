import { describe, expect, it } from 'vitest';
import type { CanonicalRow as ReaderRow } from '@trading/research-contracts';
import { buildOverlayDataset, toCanonicalRowV2 } from '../src/engine/data-adapter';
import type { BacktesterDataPort } from '../src/data/reader';

const FULL_ROW: ReaderRow = {
  symbol: 'BTCUSDT',
  minute_ts: 1_700_000_000_000,
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volume: 12,
  turnover: 1260,
  oi_total_usd: 999,
  has_oi: true,
  funding_rate: 0.0001,
  has_funding: true,
  liq_long_usd: 123,
  liq_short_usd: 45,
  has_liquidations: true,
  taker_buy_volume_usd: 700,
  taker_sell_volume_usd: 560,
  has_taker_flow: true,
};

describe('toCanonicalRowV2', () => {
  it('preserves liquidation fields (no zeroing-out)', () => {
    const v2 = toCanonicalRowV2(FULL_ROW);
    expect(v2.liq_long_usd).toBe(123);
    expect(v2.liq_short_usd).toBe(45);
    expect(v2.has_liquidations).toBe(true);
  });

  it('passes taker flow and turnover through verbatim', () => {
    const v2 = toCanonicalRowV2(FULL_ROW);
    expect(v2.taker_buy_volume_usd).toBe(700);
    expect(v2.taker_sell_volume_usd).toBe(560);
    expect(v2.has_taker_flow).toBe(true);
    expect(v2.turnover).toBe(1260);
  });

  it('passes oi and funding through verbatim', () => {
    const v2 = toCanonicalRowV2(FULL_ROW);
    expect(v2.oi_total_usd).toBe(999);
    expect(v2.has_oi).toBe(true);
    expect(v2.funding_rate).toBe(0.0001);
    expect(v2.has_funding).toBe(true);
  });

  it('emits schema_version 2', () => {
    const v2 = toCanonicalRowV2(FULL_ROW);
    expect(v2.schema_version).toBe(2);
  });

  it('keeps absent liquidations absent (null/false source → null/false out)', () => {
    const v2 = toCanonicalRowV2({
      ...FULL_ROW,
      liq_long_usd: null,
      liq_short_usd: null,
      has_liquidations: false,
    });
    expect(v2.liq_long_usd).toBeNull();
    expect(v2.liq_short_usd).toBeNull();
    expect(v2.has_liquidations).toBe(false);
  });
});


// P2-19 — the funding cadence must come from the SERVER-declared DatasetDescriptor.timeframe, never the
// client's request label. buildOverlayDataset enforces request == descriptor equality and materializes
// the tape from the descriptor timeframe, so a client cannot relabel a 1m tape as 60m (60x funding).
describe('buildOverlayDataset — timeframe provenance', () => {
  const rowAt = (minute_ts: number): ReaderRow => ({ ...FULL_ROW, minute_ts });
  const makePort = (descriptorTimeframe: string): BacktesterDataPort => ({
    async listDatasets() {
      return [{
        datasetRef: 'ds1',
        symbols: ['BTCUSDT'],
        timeframe: descriptorTimeframe,
        period: { from: new Date(0).toISOString(), to: new Date(60_000).toISOString() },
      }] as never;
    },
    async openDataset(datasetRef) {
      if (datasetRef !== 'ds1') return undefined;
      const rows = [rowAt(0), rowAt(60_000)];
      return {
        async *queryRange() { yield rows; },
        async *queryOneSymbolTimeSeries() { yield rows; },
      } as never;
    },
  });
  const sel = (timeframe: string) => ({
    datasetRef: 'ds1',
    symbols: ['BTCUSDT'],
    timeframe,
    period: { from: new Date(0).toISOString(), to: new Date(120_000).toISOString() },
  });

  it('rejects a request timeframe that disagrees with the dataset descriptor (no relabeling)', async () => {
    // Real 1m dataset, client claims 60m — must fail closed, not silently 60x-charge funding.
    await expect(buildOverlayDataset(makePort('1m'), sel('60m'))).rejects.toThrow(/timeframe/i);
  });

  it('materializes the tape from the SERVER descriptor timeframe when the request matches', async () => {
    const tape = await buildOverlayDataset(makePort('1m'), sel('1m'));
    expect(tape.timeframe).toBe('1m'); // trusted server value carried onto the tape
  });
});
