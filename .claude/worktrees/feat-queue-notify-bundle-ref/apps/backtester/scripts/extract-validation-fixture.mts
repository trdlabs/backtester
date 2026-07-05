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

// Candidates: time_exit trades within row coverage — NO reconcile pre-filter
const candidates = allTrades.filter(
  (t) => t.closeReason === 'time_exit' && inCoverage(t),
);

// Pick up to 3 symbols that have ≥1 candidate
const picked: string[] = [];
for (const t of candidates) {
  if (picked.length < 3 && !picked.includes(t.symbol)) picked.push(t.symbol);
}

const trades = candidates
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

// Guard: exit BEFORE writing if there's nothing to write
if (trades.length === 0) {
  console.error('No time_exit trades found within row coverage — aborting, fixture not written.');
  process.exit(1);
}

const rows = Object.fromEntries(picked.map((s) => [s, rowsBySymbol[s]]));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ trades, rowsBySymbol: rows }, null, 0));
console.log(`wrote ${OUT}: ${trades.length} trades, ${picked.length} symbols (${picked.join(',')})`);
