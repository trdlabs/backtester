import type { CanonicalRowV2 } from '@trading/research-contracts/research';

// Extends the exec-validation PaperTrade shape with source evidence the mock
// tradesByRun ClosedTrade carries but the old extractor dropped.
export interface SignalParityGoldenTrade {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  openedAtMs: number;
  closedAtMs: number;
  pnlPct: string;
  closeReason: string;
  closeReasonRaw: string | null;
  entryPrice: string | null;
  exitPrice: string | null;
}

export interface SignalParityFixture {
  symbol: string;
  timeframe: '1m';
  trades: SignalParityGoldenTrade[];
  rows: CanonicalRowV2[];
}
