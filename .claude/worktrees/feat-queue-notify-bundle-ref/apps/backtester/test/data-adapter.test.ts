import { describe, expect, it } from 'vitest';
import type { CanonicalRow as ReaderRow } from '@trading/research-contracts';
import { toCanonicalRowV2 } from '../src/engine/data-adapter';

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
