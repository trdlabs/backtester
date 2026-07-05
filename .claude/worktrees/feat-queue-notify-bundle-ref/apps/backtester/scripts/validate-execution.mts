import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayPnlPct, type PaperTrade } from '../test/helpers-replay.js';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE =
  process.env.SLICE_PATH ??
  resolve(
    HERE,
    '../../../../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json',
  );
const TOL = Number(process.env.PNL_TOL ?? 1e-4);

async function main() {
  let raw: string;
  try {
    raw = readFileSync(SLICE, 'utf8');
  } catch (e: any) {
    console.error(`[validate-execution] slice not found at ${SLICE}`);
    console.error('  Set SLICE_PATH env to override. This is a manual harness — not CI.');
    process.exit(1);
  }

  const b = JSON.parse(raw);
  const rowsBySymbol = b.historical.rowsBySymbol as Record<string, CanonicalRowV2[]>;
  const allTrades: PaperTrade[] = Object.values(b.tradesByRun as Record<string, any[]>).flat();

  const inCov = (t: PaperTrade) => {
    const r = rowsBySymbol[t.symbol];
    return r?.length && t.openedAtMs >= r[0].minute_ts && t.closedAtMs <= r[r.length - 1].minute_ts;
  };

  const scope = allTrades.filter((t) => t.closeReason === 'time_exit' && inCov(t));
  const excluded = allTrades.filter((t) => !(t.closeReason === 'time_exit' && inCov(t)));

  let matched = 0;
  const misses: string[] = [];

  for (const sym of new Set(scope.map((t) => t.symbol))) {
    const symTrades = scope.filter((t) => t.symbol === sym);
    const results = await replayPnlPct(sym, rowsBySymbol[sym], symTrades);
    for (const r of results) {
      if (Math.abs(r.backtestPnlPct - r.paperPnlPct) <= TOL) {
        matched += 1;
      } else {
        misses.push(
          `${sym} ${r.tradeId}: backtest=${r.backtestPnlPct.toFixed(4)} paper=${r.paperPnlPct.toFixed(4)}`,
        );
      }
    }
  }

  console.log('\n============== EXECUTION VALIDATION (paper engine, time_exit) ==============');
  console.log(
    `in-scope time_exit trades: ${scope.length}  | matched (<=${TOL}): ${matched}  | mismatched: ${misses.length}`,
  );
  for (const m of misses) console.log('  MISS ', m);
  const byReason: Record<string, number> = {};
  for (const t of excluded) byReason[t.closeReason] = (byReason[t.closeReason] ?? 0) + 1;
  console.log(`EXCLUDED ${excluded.length} (trigger-close / out-of-coverage):`, JSON.stringify(byReason));
  console.log('=============================================================================');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
