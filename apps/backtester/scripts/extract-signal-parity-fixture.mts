import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import type { SignalParityFixture, SignalParityGoldenTrade } from '../test/long-oi-parity/golden-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE =
  process.env.SLICE_PATH ??
  resolve(HERE, '../../../../mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json');
const OUT = resolve(HERE, '../test/fixtures/exec-validation/long-oi-signal-parity.json');

const SYMBOL = 'ESPORTSUSDT';

const bundle = JSON.parse(readFileSync(SLICE, 'utf8'));
const rows: CanonicalRowV2[] = bundle.historical.rowsBySymbol[SYMBOL];
const allTrades = Object.values(bundle.tradesByRun as Record<string, any[]>).flat();

const trades: SignalParityGoldenTrade[] = allTrades
  .filter((t) => t.symbol === SYMBOL)
  .sort((a, b) => a.openedAtMs - b.openedAtMs)
  .map((t) => ({
    tradeId: t.tradeId,
    symbol: t.symbol,
    side: t.side as 'long' | 'short',
    openedAtMs: t.openedAtMs,
    closedAtMs: t.closedAtMs,
    pnlPct: String(t.pnlPct),
    closeReason: t.closeReason,
    closeReasonRaw: t.closeReasonRaw ?? null,
    entryPrice: t.entryPrice ?? null,
    exitPrice: t.exitPrice ?? null,
  }));

// Guard: exit BEFORE writing if there's nothing to write
if (trades.length === 0) {
  console.error(`No ${SYMBOL} trades found in slice — aborting, fixture not written.`);
  process.exit(1);
}
if (!rows?.length) {
  console.error(`No ${SYMBOL} rows found in slice — aborting, fixture not written.`);
  process.exit(1);
}

const fixture: SignalParityFixture = { symbol: SYMBOL, timeframe: '1m', trades, rows };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture, null, 2));
console.log(`wrote ${OUT}: ${trades.length} trades, ${rows.length} rows (${SYMBOL})`);
