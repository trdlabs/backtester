import { normalizeCloseReason } from './normalize-close-reason.js';
import type { SignalParityGoldenTrade } from './golden-types.js';
import type { GeneratedTrade } from './run-long-oi.js';

export interface ParityReport {
  ok: boolean;
  matched: { goldenId: string; pnlDeltaPct: number; reasonBucket: string }[];
  failures: string[];
  flaggedOtherOther: string[];
}

export function scorableGolden(golden: SignalParityGoldenTrade[], firstRowTs: number, warmupMs = 60 * 60_000): SignalParityGoldenTrade[] {
  return golden.filter((t) => t.openedAtMs >= firstRowTs + warmupMs);
}

export function matchTrades(
  golden: SignalParityGoldenTrade[],
  generated: GeneratedTrade[],
  window: { startMs: number; endMs: number },
  tolPct = 0.05,
): ParityReport {
  const failures: string[] = [];
  const matched: ParityReport['matched'] = [];
  const flaggedOtherOther: string[] = [];
  const inWin = (ts: number) => ts >= window.startMs && ts <= window.endMs;

  const genByEntry = new Map(generated.map((t) => [t.entryTs, t]));
  for (const gt of golden) {
    const m = genByEntry.get(gt.openedAtMs);
    if (!m) { failures.push(`no generated entry at ${gt.openedAtMs} (golden ${gt.tradeId})`); continue; }
    if (m.side !== gt.side) failures.push(`side mismatch ${gt.tradeId}: ${m.side} != ${gt.side}`);
    if (m.exitTs !== gt.closedAtMs) failures.push(`exit bar mismatch ${gt.tradeId}: ${m.exitTs} != ${gt.closedAtMs}`);
    const gBucket = normalizeCloseReason(gt.closeReasonRaw ?? gt.closeReason); // raw-first: closeReasonRaw (tp2/hard_stop) is more specific than the generalized closeReason
    const mBucket = normalizeCloseReason(m.closeReason);
    if (gBucket !== mBucket) failures.push(`close-reason mismatch ${gt.tradeId}: ${mBucket} != ${gBucket}`);
    else if (gBucket === 'other') flaggedOtherOther.push(gt.tradeId);
    const delta = Math.abs(m.pnlPct - Number(gt.pnlPct));
    if (delta > tolPct) failures.push(`pnl% delta ${delta.toFixed(4)} > ${tolPct} (${gt.tradeId})`);
    matched.push({ goldenId: gt.tradeId, pnlDeltaPct: delta, reasonBucket: mBucket });
  }

  // over-trigger: every in-window generated entry must correspond to a golden entry
  const goldenEntry = new Set(golden.map((t) => t.openedAtMs));
  for (const m of generated) {
    if (inWin(m.entryTs) && !goldenEntry.has(m.entryTs)) failures.push(`extra generated entry at ${m.entryTs} (not in golden)`);
  }
  return { ok: failures.length === 0, matched, failures, flaggedOtherOther };
}
