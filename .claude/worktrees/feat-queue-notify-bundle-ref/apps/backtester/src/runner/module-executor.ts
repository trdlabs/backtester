// Module execution seam (mirrors trading-platform 019's ModuleExecutor/ExecutorRouter idea).
//
// An executor turns market data into per-bar long/flat entry signals. The trusted in-process executor
// reproduces the Slice 1 momentum logic byte-for-byte (so the golden result_hash is unchanged); the
// sandbox executor (src/sandbox) runs an untrusted bundle in Docker behind the SAME interface. The
// runner's PnL / risk / metrics stay trusted and identical regardless of which executor produced the
// signals — sizing/execution never live in the untrusted module.

import type { ReaderRow } from '@trading/research-contracts';

export interface SymbolSeries {
  readonly symbol: string;
  readonly candles: readonly ReaderRow[];
}

export interface ModuleExecutor {
  /** Per-symbol long/flat signal arrays; `signals[i]` is the entry signal evaluated for bar `i`. */
  computeSignals(series: readonly SymbolSeries[], seed: number): Promise<Map<string, boolean[]>>;
  close?(): Promise<void>;
}

/** Trusted in-process momentum: long when the previous bar closed up vs. the bar before it. */
export class TrustedMomentumExecutor implements ModuleExecutor {
  async computeSignals(series: readonly SymbolSeries[], _seed: number): Promise<Map<string, boolean[]>> {
    const out = new Map<string, boolean[]>();
    for (const { symbol, candles } of series) {
      out.set(
        symbol,
        candles.map((_, i) => i >= 2 && candles[i - 1]!.close > candles[i - 2]!.close),
      );
    }
    return out;
  }
}
