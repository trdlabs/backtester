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

/**
 * Find the row whose minute_ts is the greatest value <= ts.
 * Trades are expected to land on exact minute boundaries, but we do a floor
 * lookup to be defensive.
 */
function findRow(
  rows: CanonicalRowV2[],
  ts: number,
): CanonicalRowV2 | undefined {
  // rows are in ascending order by minute_ts
  let best: CanonicalRowV2 | undefined;
  for (const r of rows) {
    if (r.minute_ts <= ts) best = r;
    else break;
  }
  return best;
}

describe('execution validation — backtester fill model matches close-to-close price', () => {
  it('per-trade backtestPnlPct equals independent c2c computation (engine regression guard)', async () => {
    expect(fixture.trades.length).toBeGreaterThan(0);

    let reconciledCount = 0;

    for (const sym of Object.keys(fixture.rowsBySymbol)) {
      const symTrades = fixture.trades.filter((t) => t.symbol === sym);
      if (symTrades.length === 0) continue;

      const rows = fixture.rowsBySymbol[sym];
      const results = await replayPnlPct(sym, rows, symTrades);

      for (const r of results) {
        const trade = symTrades.find((t) => t.tradeId === r.tradeId)!;

        // Compute c2c independently from fixture rows (no dependency on paper engine math)
        const entryRow = findRow(rows, trade.openedAtMs);
        const exitRow = findRow(rows, trade.closedAtMs);
        if (!entryRow || !exitRow) {
          throw new Error(
            `exec-validation: no row found for trade ${trade.tradeId} (${sym}) at open=${trade.openedAtMs} / close=${trade.closedAtMs}`,
          );
        }
        const entryClose = entryRow.close;
        const exitClose = exitRow.close;
        const c2c =
          trade.side === 'long'
            ? ((exitClose - entryClose) / entryClose) * 100
            : ((entryClose - exitClose) / entryClose) * 100;

        const paper = Number(trade.pnlPct);

        // Assertion A (engine regression guard — ALL trades):
        // Proves the backtester fills at the bar CLOSE.
        // A fill-model regression to open/next-bar would break this.
        // This is NOT circular: it computes c2c independently and compares
        // to the backtester's replay output.
        expect(r.backtestPnlPct).toBeCloseTo(c2c, 4);

        // Assertion B (paper fidelity — reconciling trades only):
        // When the snapshot bars reproduce the paper engine's live fill prices,
        // the backtester must also match paper.
        // 1e-3 is intentionally coarser than Assertion A's 1e-4: it screens out trades where
        // snapshot bars diverged from the paper engine's live fills, not a fill-model precision gate.
        // Do NOT tighten this to match Assertion A — that would silently exclude divergent trades.
        if (Math.abs(c2c - paper) <= 1e-3) {
          expect(r.backtestPnlPct).toBeCloseTo(paper, 4);
          reconciledCount++;
        } else {
          console.warn(
            `exec-validation data-divergence: ${sym} ${trade.tradeId}: c2c=${c2c.toFixed(6)} paper=${paper.toFixed(6)} — snapshot bars diverge from the paper engine's live fills`,
          );
        }
      }
    }

    // At least one trade must reconcile with paper so the paper-fidelity
    // assertion path is non-empty (guards against a fixture of all-divergent trades).
    expect(reconciledCount).toBeGreaterThan(0);
  });
});
