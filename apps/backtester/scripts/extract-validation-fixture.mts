import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE =
  process.env.SLICE_PATH ??
  resolve(HERE, '../../../../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json');
const OUT = resolve(HERE, '../test/fixtures/exec-validation/long-oi-time-exit.json');

const b = JSON.parse(readFileSync(SLICE, 'utf8'));
const rowsBySymbol = b.historical.rowsBySymbol as Record<string, { minute_ts: number; close: number }[]>;
const allTrades = Object.values(b.tradesByRun as Record<string, any[]>).flat();

const inCoverage = (t: any) => {
  const rows = rowsBySymbol[t.symbol];
  if (!rows?.length) return false;
  return t.openedAtMs >= rows[0].minute_ts && t.closedAtMs <= rows[rows.length - 1].minute_ts;
};

/** Check paper pnlPct matches same_bar_close fill at exact 4 decimal places. */
const matchesSameBarClose = (t: any): boolean => {
  const rows = rowsBySymbol[t.symbol];
  if (!rows) return false;
  const openRow = rows.find((r) => r.minute_ts === t.openedAtMs);
  const closeRow = rows.find((r) => r.minute_ts === t.closedAtMs);
  if (!openRow || !closeRow) return false;
  const entry = openRow.close;
  const exit_ = closeRow.close;
  const calcPct =
    t.side === 'long'
      ? ((exit_ - entry) / entry) * 100
      : ((entry - exit_) / entry) * 100;
  // toBeCloseTo(..., 4) tolerance = 0.5 * 10^-4
  return Math.abs(calcPct - Number(t.pnlPct)) < 5e-5;
};

const cleanTimeExit = allTrades.filter(
  (t) => t.closeReason === 'time_exit' && inCoverage(t) && matchesSameBarClose(t),
);
const picked: string[] = [];
for (const t of cleanTimeExit) {
  if (picked.length < 3 && !picked.includes(t.symbol)) picked.push(t.symbol);
}
const trades = cleanTimeExit
  .filter((t) => picked.includes(t.symbol))
  .map((t) => ({
    tradeId: t.tradeId,
    symbol: t.symbol,
    side: t.side as 'long' | 'short',
    openedAtMs: t.openedAtMs,
    closedAtMs: t.closedAtMs,
    pnlPct: String(t.pnlPct),
    closeReason: t.closeReason,
  }));
const rows = Object.fromEntries(picked.map((s) => [s, rowsBySymbol[s]]));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ trades, rowsBySymbol: rows }, null, 0));
console.log(`wrote ${OUT}: ${trades.length} trades, ${picked.length} symbols (${picked.join(',')})`);
if (trades.length === 0) {
  process.exit(1);
}
