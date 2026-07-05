import type { CanonicalRowV2 } from '@trading/research-contracts/research';

export interface FixtureFile {
  readonly datasetRef: string;
  readonly timeframe: string;
  readonly rows: CanonicalRowV2[];
}

/** Flatten exec-validation `rowsBySymbol` into a flat FixtureFile.rows[] (each row keeps its `symbol`). */
export function toFixtureFile(
  execValidation: { rowsBySymbol: Record<string, CanonicalRowV2[]> },
  datasetRef: string,
  timeframe: string,
): FixtureFile {
  const rows: CanonicalRowV2[] = [];
  for (const symbol of Object.keys(execValidation.rowsBySymbol)) {
    for (const r of execValidation.rowsBySymbol[symbol]!) rows.push(r);
  }
  return { datasetRef, timeframe, rows };
}

/** Min ts, max ts + one bar (60s), and sorted unique symbols across all rows. */
export function fixtureWindow(rows: readonly CanonicalRowV2[]): {
  fromMs: number;
  toMs: number;
  symbols: string[];
} {
  let fromMs = Infinity;
  let toMs = -Infinity;
  const symbols = new Set<string>();
  for (const r of rows) {
    fromMs = Math.min(fromMs, r.minute_ts);
    toMs = Math.max(toMs, r.minute_ts + 60_000);
    symbols.add(r.symbol);
  }
  return { fromMs, toMs, symbols: [...symbols].sort() };
}
