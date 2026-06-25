import { runBacktest } from '../src/engine/runner.js';
import type { FundingLedgerEntry } from '../src/engine/runner.js';
import type { BacktestRunResult } from '../src/engine/artifacts.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK, REALISM_EXEC } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type {
  BacktestRunRequest,
  ExecutionProfile,
  MarketTapeDataset,
  StrategyModule,
  CanonicalRowV2,
} from '@trading/research-contracts/research';

export type PaperTrade = {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  openedAtMs: number;
  closedAtMs: number;
  pnlPct: string;
  closeReason: string;
};

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

export function tapeFromRows(symbol: string, rows: CanonicalRowV2[]): MarketTapeDataset {
  const built = marketTapeFromCanonicalRows(symbol, '1m', rows);
  if (!built.ok) throw new Error(`tape build failed for ${symbol}: ${built.detail}`);
  return built.tape;
}

export function makeReplayModule(symbol: string, trades: PaperTrade[]): StrategyModule {
  const openMap = new Map(trades.map((t) => [t.openedAtMs, t.side]));
  const closes = new Set(trades.map((t) => t.closedAtMs));
  return {
    manifest: {
      ...shortAfterPump.manifest,
      id: `replay-${symbol}`,
      version: '1.0.0',
      name: `replay-${symbol}`,
      hooks: ['onBarClose', 'onPositionBar'],
    },
    onBarClose: (ctx: any) => {
      const side = openMap.get(ctx.bar.ts);
      return side !== undefined ? { kind: 'enter', side } : { kind: 'idle' };
    },
    onPositionBar: (ctx: any) => (closes.has(ctx.bar.ts) ? { kind: 'exit', target: 'replay' } : { kind: 'idle' }),
  } as unknown as StrategyModule;
}

export async function replayPnlPct(
  symbol: string,
  rows: CanonicalRowV2[],
  trades: PaperTrade[],
): Promise<{ tradeId: string; backtestPnlPct: number; paperPnlPct: number }[]> {
  const tape = tapeFromRows(symbol, rows);
  const mod = makeReplayModule(symbol, trades);
  const registry = createModuleRegistry({
    strategies: [mod],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [SAME_BAR_NO_COST],
  });
  const req = {
    runId: `replay-${symbol}`,
    mode: 'research',
    moduleRef: { id: mod.manifest.id, version: '1.0.0' },
    datasetRef: symbol,
    symbols: [symbol],
    timeframe: '1m',
    period: {
      from: new Date(rows[0].minute_ts).toISOString(),
      to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString(),
    },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'paper_match', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;

  const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
  if (out.status !== 'completed') {
    throw new Error(
      `replay not completed: ${JSON.stringify('validation' in out ? out.validation : out)}`,
    );
  }

  // Match by entryTs AND side to guard against collisions (Fix 3)
  const paperByKey = new Map(trades.map((t) => [`${t.openedAtMs}:${t.side}`, t]));

  return out.baseline.trades.map((bt) => {
    // Determine side from the backtester trade (prefer bt.side, fall back to paper match by ts)
    const btSide: 'long' | 'short' | undefined =
      'side' in bt && (bt as any).side ? (bt as any).side : undefined;

    // Try exact key match first (entryTs + side from bt), then fall back to entryTs-only for single-side symbols
    let paper: PaperTrade | undefined;
    if (btSide) {
      paper = paperByKey.get(`${bt.entryTs}:${btSide}`);
    }
    if (!paper) {
      // Fall back: find by entryTs alone — safe when there's only one trade at this ts
      const candidates = trades.filter((t) => t.openedAtMs === bt.entryTs);
      if (candidates.length === 1) {
        paper = candidates[0];
      } else if (candidates.length > 1) {
        throw new Error(
          `replayPnlPct: multiple paper trades at entryTs=${bt.entryTs} for ${symbol} and no side on bt — cannot match unambiguously`,
        );
      }
    }
    if (!paper) {
      throw new Error(
        `replayPnlPct: no paper trade matched bt entryTs=${bt.entryTs} side=${btSide ?? 'unknown'} for ${symbol}`,
      );
    }

    // Fix 2: side-aware pnlPct using the matched paper trade's side
    const backtestPnlPct =
      paper.side === 'short'
        ? ((bt.entryFillPrice - bt.exitFillPrice) / bt.entryFillPrice) * 100
        : ((bt.exitFillPrice - bt.entryFillPrice) / bt.entryFillPrice) * 100;

    return {
      tradeId: paper.tradeId,
      backtestPnlPct,
      paperPnlPct: Number(paper.pnlPct),
    };
  });
}

/**
 * Run the recorded trades through the real engine under REALISM_EXEC and surface the funding ledger.
 * Mirrors replayPnlPct's run wiring but binds the realism execution profile (funding ON). `size` is the
 * opened position size (single fill) — used by tests to convert per-bar cash funding into a notional fraction.
 */
export async function runRealismLedger(
  symbol: string,
  rows: CanonicalRowV2[],
  trades: PaperTrade[],
): Promise<{ ledger: FundingLedgerEntry[]; size: number; result: BacktestRunResult }> {
  const tape = tapeFromRows(symbol, rows);
  const mod = makeReplayModule(symbol, trades);
  const registry = createModuleRegistry({
    strategies: [mod],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [REALISM_EXEC],
  });
  const req = {
    runId: `realism-${symbol}`,
    mode: 'research',
    moduleRef: { id: mod.manifest.id, version: '1.0.0' },
    datasetRef: symbol,
    symbols: [symbol],
    timeframe: '1m',
    period: {
      from: new Date(rows[0].minute_ts).toISOString(),
      to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString(),
    },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'realism_exec', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;

  const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
  if (out.status !== 'completed') {
    throw new Error(
      `realism run not completed: ${JSON.stringify('validation' in out ? out.validation : out)}`,
    );
  }

  const result = out.baseline;
  const ledger = (result.evidence.fundingLedger ?? []) as FundingLedgerEntry[];
  // Open fill: orderId has the form `ord-{symbol}-{barIndex}-open`; it has no `kind` field (only add/close/
  // protection fills carry `kind`). Use orderId suffix to unambiguously identify the entry fill.
  const openFill = result.evidence.simulatedFills.find((f: any) => f.orderId.endsWith('-open'));
  const size = openFill?.size ?? 0;
  return { ledger, size, result };
}
