import { describe, it, expect } from 'vitest';
import { normalizeCloseReason } from './normalize-close-reason.js';

describe('normalizeCloseReason', () => {
  it('maps take-profit tokens', () => {
    for (const r of ['take_profit_final', 'tp1', 'tp2']) expect(normalizeCloseReason(r)).toBe('take_profit');
  });
  it('maps stop-loss tokens incl the real hard_stop raw', () => {
    for (const r of ['stop_loss', 'sl', 'hard_stop']) expect(normalizeCloseReason(r)).toBe('stop_loss');
  });
  it('maps time-exit tokens', () => {
    for (const r of ['time_exit', 'max_hold', 'watch_expire']) expect(normalizeCloseReason(r)).toBe('time_exit');
  });
  it('maps every engine CloseReason literal to its canonical bucket', () => {
    // Engine literals from apps/backtester/src/engine/artifacts.ts:108 `type CloseReason`:
    //   'overlay_early_exit' | 'end_of_data' | 'forced_mtm' | 'stop_hit' | 'take_hit' | (string & {})
    // take_hit / stop_hit: 024 protection-triggered (runner-owned intrabar hard-guard) hits — direct
    // TP/SL analogues.
    expect(normalizeCloseReason('take_hit')).toBe('take_profit');
    expect(normalizeCloseReason('stop_hit')).toBe('stop_loss');
    // end_of_data / forced_mtm: forced mark-to-market close because the data window ran out — the
    // engine's doc comment states end_of_data carries forced_mtm semantics. Neither is a price-target
    // or stop hit; both are duration/time-boundary driven, so they bucket with time_exit.
    expect(normalizeCloseReason('end_of_data')).toBe('time_exit');
    expect(normalizeCloseReason('forced_mtm')).toBe('time_exit');
    // overlay_early_exit: a strategy/overlay-authored discretionary early exit — not a profit target,
    // not a stop, not a duration boundary. No non-other bucket applies, so it maps to 'other'.
    expect(normalizeCloseReason('overlay_early_exit')).toBe('other');
  });
  it('unknown/empty → other', () => {
    for (const r of ['weird', '', null, undefined]) expect(normalizeCloseReason(r)).toBe('other');
  });
});
