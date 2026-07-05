import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignalParityFixture } from './golden-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/exec-validation/long-oi-signal-parity.json'), 'utf8'),
) as SignalParityFixture;

describe('long-oi signal-parity golden fixture', () => {
  it('has 9 ESPORTSUSDT long trades with source evidence + 1-minute rows', () => {
    expect(fx.symbol).toBe('ESPORTSUSDT');
    expect(fx.trades).toHaveLength(9);
    expect(fx.trades.every((t) => t.side === 'long')).toBe(true);
    expect(fx.trades.every((t) => t.closeReasonRaw !== undefined && t.entryPrice !== undefined)).toBe(true);
    // stop-loss trades carry the hard_stop raw token (locks Task-1 mapping relevance)
    const sl = fx.trades.filter((t) => t.closeReason === 'stop_loss');
    expect(sl.length).toBeGreaterThan(0);
    expect(sl.every((t) => t.closeReasonRaw === 'hard_stop')).toBe(true);
    expect(fx.rows.length).toBeGreaterThan(1300);
    expect(fx.rows[0]!.schema_version).toBe(2);
  });
});
