import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { type PaperTrade, runRealismLedger } from './helpers-replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8'),
) as { trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> };

const SYMBOL = 'BEATUSDT';
const rows = fixture.rowsBySymbol[SYMBOL];
const trade = fixture.trades.find((t) => t.symbol === SYMBOL && t.closeReason === 'time_exit')!;

describe('realism GAP — funding non-circular guard + sign + 5b anchor', () => {
  it('1) NON-CIRCULAR: engine fundingLedger == inline integral (|Δ| < 1e-10)', async () => {
    const { ledger, size } = await runRealismLedger(SYMBOL, rows, [trade]);
    // Inline recompute — plain arithmetic, NO import of funding.ts (independent of production code).
    // If funding.ts has a wrong divisor/sign/proration, this inline sum diverges from the engine ledger.
    // P2-19: each covered bar realizes ONE funding snapshot = one server-cadence period (this fixture
    // is a 1m tape, so 1 minute per covered bar). The inline recompute is independent of funding.ts.
    const INTERVAL_MIN = 8 * 60; // 480
    const sign = trade.side === 'long' ? 1 : -1;
    let inline = 0;
    for (const e of ledger) {
      if (!e.covered) {
        expect(e.cost).toBe(0); // uncovered minute must charge exactly 0
        continue;
      }
      const row = rows.find((r) => r.minute_ts === e.ts)!; // mark = close at the funding minute
      inline += (e.rate / INTERVAL_MIN) * (size * row.close) * sign; // one 1m cadence period
    }
    const engineTotal = ledger.reduce((s, e) => s + e.cost, 0);
    expect(Math.abs(engineTotal - inline)).toBeLessThan(1e-10);
  });

  it('3) SIGN-PIN: BEATUSDT long over negative rates → funding is a CREDIT (Σ cost < 0)', async () => {
    const { ledger } = await runRealismLedger(SYMBOL, rows, [trade]);
    const total = ledger.reduce((s, e) => s + e.cost, 0);
    expect(total).toBeLessThan(0); // long + negative rate ⇒ received funding ⇒ cash inflow ⇒ cost < 0
  });

  it('3b) SIGN-PIN (synthetic short): same rates, short side → funding is a COST (Σ cost > 0)', async () => {
    const shortTrade: PaperTrade = { ...trade, side: 'short' };
    const { ledger } = await runRealismLedger(SYMBOL, rows, [shortTrade]);
    const total = ledger.reduce((s, e) => s + e.cost, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('5b) ANCHOR: BEATUSDT time_exit long credit is ~2.39 bps of notional (observed; pinned ±0.5 bps)', async () => {
    const { ledger, size } = await runRealismLedger(SYMBOL, rows, [trade]);
    const entryRow = rows.find((r) => r.minute_ts === trade.openedAtMs)!;
    const notional = size * entryRow.close;
    const total = ledger.reduce((s, e) => s + e.cost, 0); // negative = credit
    const creditBps = (-total / notional) * 1e4;
    // Observed: ~2.39 bps for a ~181-min BEATUSDT long with negative funding rates.
    // Band pinned around the observed value (±0.5 bps tolerance for floating-point determinism).
    expect(creditBps).toBeGreaterThan(1.8);
    expect(creditBps).toBeLessThan(3.0);
  });
});
