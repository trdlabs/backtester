export type CanonicalCloseReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'other';

// Covers BOTH the golden mock vocabulary (mock tradesByRun closeReason/closeReasonRaw:
// take_profit_final, tp2, stop_loss, hard_stop, time_exit, other) AND the engine
// Trade.closeReason literals (apps/backtester/src/engine/artifacts.ts:108, `type CloseReason`):
//   'overlay_early_exit' | 'end_of_data' | 'forced_mtm' | 'stop_hit' | 'take_hit' | (string & {})
//
// Bucketing of the engine literals (Step 1):
// - 'take_hit'  -> take_profit : 024 protection-triggered (runner-owned intrabar hard-guard) TP hit.
// - 'stop_hit'  -> stop_loss   : 024 protection-triggered (runner-owned intrabar hard-guard) SL hit.
// - 'end_of_data' / 'forced_mtm' -> other : forced mark-to-market close because the backtest data
//     window ran out — an artifact of the harness, NOT a strategy-authored duration exit. Bucketing
//     these with the golden `time_exit` (a real watch_expire/max_hold strategy decision) would let a
//     harness truncation false-match a strategy time exit, so they deliberately fall through to 'other'.
// - 'overlay_early_exit' -> other : a strategy/overlay-authored discretionary early exit. It is not a
//     profit target, not a stop, and not a duration boundary, so no non-other bucket applies.
const TAKE_PROFIT = new Set(['take_profit', 'take_profit_final', 'tp1', 'tp2', 'take_hit']);
const STOP_LOSS = new Set(['stop_loss', 'sl', 'hard_stop', 'stop_hit']);
// engine end_of_data/forced_mtm are backtest data-window forced closes, NOT strategy time-exits -> deliberately fall through to 'other'
const TIME_EXIT = new Set(['time_exit', 'max_hold', 'watch_expire']);

export function normalizeCloseReason(raw: string | null | undefined): CanonicalCloseReason {
  if (!raw) return 'other';
  const r = raw.toLowerCase();
  if (TAKE_PROFIT.has(r)) return 'take_profit';
  if (STOP_LOSS.has(r)) return 'stop_loss';
  if (TIME_EXIT.has(r)) return 'time_exit';
  return 'other';
}
