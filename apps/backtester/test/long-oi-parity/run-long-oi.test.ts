import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongOiOnRows } from './run-long-oi.js';
import type { SignalParityFixture } from './golden-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/exec-validation/long-oi-signal-parity.json'), 'utf8'),
) as SignalParityFixture;

describe('runLongOiOnRows', () => {
  it('generates trades from raw bars (tradeCount=0 regression guard; ctx.market/OI populated)', async () => {
    const trades = await runLongOiOnRows(fx.rows, fx.symbol);
    expect(trades.length).toBeGreaterThan(0); // 0 ⇒ 1h-regression OR MarketTape missing OI ⇒ HARD FAIL
    expect(trades.every((t) => t.side === 'long')).toBe(true);
    expect(trades.every((t) => Number.isFinite(t.entryTs) && Number.isFinite(t.exitTs))).toBe(true);
  }, 30_000);
});
