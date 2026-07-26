// Ф3 (shared-execution-engine, rollout шаг 4) — this module is now an IMPORT of the shared core.
//
// The deterministic position/portfolio state machine moved to `@trdlabs/engine`
// (`src/core/portfolio.ts`) during the Ф2 extraction. Three API facts the host must know, all
// recorded in the initiative card as the *prescribed* Ф3 migration notes:
//
//   • SSOT decision 4 (funding) — `chargeFunding` (cash-only) became `settleFunding`: a settlement
//     moves cash AND accrues against the open position, so the closing `Trade` carries the holding
//     cost in `realizedPnl` (`fundingPaid` key, omitted when zero). Funding is opt-in, so the
//     default OHLCV path stays byte-identical.
//   • `settlePartialClose(fill, fraction, reason)` folded into `settleClose(fill, reason, fraction)`
//     — one entry point, `fraction = 1` meaning a full close.
//   • `PendingOrder` carries a risk-authored `notional` instead of `sizingPct` (SSOT decision 3:
//     risk owns sizing outright and hands execution a finished notional), and `settleAdd` lost its
//     unused `mode` argument (the donor ignored it: `_mode`).
//
// No local copy — the engine owns execution semantics.

export { Portfolio } from '@trdlabs/engine';
export type { CloseFill, OpenFill, OpenPosition, PendingOrder } from '@trdlabs/engine';
