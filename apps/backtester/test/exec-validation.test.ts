import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayPnlPct, type PaperTrade } from './helpers-replay.js';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8'),
) as {
  trades: PaperTrade[];
  rowsBySymbol: Record<string, CanonicalRowV2[]>;
};

describe('execution validation — backtester reproduces paper pnlPct on time_exit trades', () => {
  it('per-trade backtest pnlPct equals paper pnlPct', async () => {
    expect(fixture.trades.length).toBeGreaterThan(0);
    for (const sym of Object.keys(fixture.rowsBySymbol)) {
      const symTrades = fixture.trades.filter((t) => t.symbol === sym);
      if (symTrades.length === 0) continue;
      const results = await replayPnlPct(sym, fixture.rowsBySymbol[sym], symTrades);
      for (const r of results) {
        expect(r.backtestPnlPct).toBeCloseTo(r.paperPnlPct, 4);
      }
    }
  });
});
