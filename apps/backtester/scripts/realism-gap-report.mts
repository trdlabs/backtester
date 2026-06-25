// Deterministic realism GAP report: replays recorded trades under REALISM_EXEC and decomposes per-trade
// cost drag (baseline / fee / slippage / funding) in bps. Output is canonical (sorted, no timestamps).
// Run: npx tsx apps/backtester/scripts/realism-gap-report.mts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealismLedger, type PaperTrade } from '../test/helpers-replay.js';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../test/fixtures/exec-validation/long-oi-time-exit.json');

interface DecomposedRow {
  symbol: string;
  tradeId: string;
  side: 'long' | 'short';
  openedAtMs: number;
  closeReason: string;
  heldMinutes: number;
  coveredMinutes: number;
  fundingCoveragePct: number;
  baselinePnlPct: number;
  feeDragBps: number;
  slippageDragBps: number;
  fundingDragBps: number;
  realisticPnlPct: number;
  gapBps: number;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(FIXTURE, 'utf8');
  } catch (e: any) {
    console.error(`[realism-gap-report] fixture not found at ${FIXTURE}`);
    process.exit(1);
  }

  const b = JSON.parse(raw) as {
    trades: PaperTrade[];
    rowsBySymbol: Record<string, CanonicalRowV2[]>;
  };

  // Scope: only trades that are fully covered by available rows
  const inCov = (t: PaperTrade): boolean => {
    const r = b.rowsBySymbol[t.symbol];
    return (
      r !== undefined &&
      r.length > 0 &&
      t.openedAtMs >= r[0].minute_ts &&
      t.closedAtMs <= r[r.length - 1].minute_ts
    );
  };

  const scope = b.trades.filter((t) => inCov(t));

  // Sort by symbol then openedAtMs for deterministic output
  scope.sort((a, b) => {
    if (a.symbol < b.symbol) return -1;
    if (a.symbol > b.symbol) return 1;
    return a.openedAtMs - b.openedAtMs;
  });

  const rows: DecomposedRow[] = [];

  for (const trade of scope) {
    const rowsForSym = b.rowsBySymbol[trade.symbol];
    const { ledger, size, result } = await runRealismLedger(trade.symbol, rowsForSym, [trade]);

    const fills = result.evidence.simulatedFills as readonly Record<string, any>[];
    const openFill = fills.find((f: any) => f.orderId.endsWith('-open'));
    const closeFill = fills.find((f: any) => f.orderId.endsWith('-close'));

    // Entry/exit close prices from the tape rows (baseline — same_bar_close of next bar after entry ts
    // is what REALISM_EXEC uses with next_bar_open fill, so we use fill prices directly)
    const entryFillPrice: number = openFill?.fillPrice ?? 0;
    const exitFillPrice: number = closeFill?.fillPrice ?? 0;
    const notional: number = size * entryFillPrice;

    // Baseline pnlPct: side-aware price move only (no costs)
    const baselinePnlPct: number =
      trade.side === 'long'
        ? ((exitFillPrice - entryFillPrice) / entryFillPrice) * 100
        : ((entryFillPrice - exitFillPrice) / entryFillPrice) * 100;

    // Fee drag: sum of all fees, sign-flipped (costs are negative bps impact)
    const totalFees: number = fills.reduce((s: number, f: any) => s + (f.feePaid ?? 0), 0);
    const feeDragBps: number = notional > 0 ? -(totalFees / notional) * 1e4 : 0;

    // Slippage drag: signed slippage vs base open (adverse to position)
    // Each fill records slippageBps; we weight by fill size / notional
    const slippageDragBps: number = notional > 0
      ? fills.reduce((s: number, f: any) => s - ((f.slippageBps ?? 0) * (f.size ?? 0) * (f.baseOpen ?? 0)) / notional, 0)
      : 0;

    // Funding drag: positive = cost (paid); negative = credit (received).
    // fundingTotal < 0 for longs held over negative rates (credit); -(negative) would flip it, so pass through directly.
    // Convention matches feeDrag/slipDrag: negative = benefit/credit, positive = drag/cost.
    const fundingTotal: number = ledger.reduce((s, e) => s + e.cost, 0);
    const fundingDragBps: number = notional > 0 ? (fundingTotal / notional) * 1e4 : 0;

    // Realistic pnlPct: from equity curve (equity_end - equity_start) / INITIAL_EQUITY
    // More precisely: equity at last bar vs initial equity (10_000 INITIAL_EQUITY)
    const eqCurve = result.evidence.equityCurve as readonly Record<string, any>[];
    const equityStart: number = 10_000; // INITIAL_EQUITY from metrics.ts
    const equityEnd: number = eqCurve.length > 0 ? eqCurve[eqCurve.length - 1].equity : equityStart;
    const realisticPnlPct: number = ((equityEnd - equityStart) / equityStart) * 100;

    const gapBps: number = (realisticPnlPct - baselinePnlPct) * 100;

    // Coverage stats
    const coveredMinutes: number = ledger.filter((e) => e.covered).length;
    const heldMinutes: number = Math.round((trade.closedAtMs - trade.openedAtMs) / 60_000);
    const fundingCoveragePct: number = heldMinutes > 0 ? (coveredMinutes / heldMinutes) * 100 : 0;

    rows.push({
      symbol: trade.symbol,
      tradeId: trade.tradeId,
      side: trade.side,
      openedAtMs: trade.openedAtMs,
      closeReason: trade.closeReason,
      heldMinutes,
      coveredMinutes,
      fundingCoveragePct,
      baselinePnlPct,
      feeDragBps,
      slippageDragBps,
      fundingDragBps,
      realisticPnlPct,
      gapBps,
    });
  }

  // Print per-trade table
  console.log('\n=================== REALISM GAP REPORT ===================');
  console.log(`trades analyzed: ${rows.length}  fixture: ${FIXTURE.split('/').slice(-3).join('/')}`);
  console.log('');

  const hdr = [
    'symbol'.padEnd(12),
    'side'.padEnd(6),
    'heldMin'.padStart(8),
    'covPct%'.padStart(8),
    'baselinePnl%'.padStart(13),
    'feeDrag bps'.padStart(12),
    'slipDrag bps'.padStart(13),
    'fndDrag bps'.padStart(12),
    'realPnl%'.padStart(10),
    'gap bps'.padStart(8),
  ].join('  ');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const r of rows) {
    const line = [
      r.symbol.padEnd(12),
      r.side.padEnd(6),
      r.heldMinutes.toString().padStart(8),
      r.fundingCoveragePct.toFixed(1).padStart(8),
      r.baselinePnlPct.toFixed(4).padStart(13),
      r.feeDragBps.toFixed(3).padStart(12),
      r.slippageDragBps.toFixed(3).padStart(13),
      r.fundingDragBps.toFixed(3).padStart(12),
      r.realisticPnlPct.toFixed(4).padStart(10),
      r.gapBps.toFixed(3).padStart(8),
    ].join('  ');
    console.log(line);
  }

  // Aggregate
  if (rows.length > 0) {
    const mean = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / arr.length;
    console.log('-'.repeat(hdr.length));
    const agg = [
      'AGGREGATE'.padEnd(12),
      ''.padEnd(6),
      ''.padStart(8),
      mean(rows.map((r) => r.fundingCoveragePct)).toFixed(1).padStart(8),
      mean(rows.map((r) => r.baselinePnlPct)).toFixed(4).padStart(13),
      mean(rows.map((r) => r.feeDragBps)).toFixed(3).padStart(12),
      mean(rows.map((r) => r.slippageDragBps)).toFixed(3).padStart(13),
      mean(rows.map((r) => r.fundingDragBps)).toFixed(3).padStart(12),
      mean(rows.map((r) => r.realisticPnlPct)).toFixed(4).padStart(10),
      mean(rows.map((r) => r.gapBps)).toFixed(3).padStart(8),
    ].join('  ');
    console.log(agg);
    console.log('');
    console.log(`note: feeDrag/slipDrag/fndDrag positive = cost (drag); negative = credit (benefit)`);
    console.log(`      fundingDrag < 0 for longs held over negative funding rates (BEATUSDT scenario)`);
  }
  console.log('===========================================================\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
