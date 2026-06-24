import { runBacktest } from '../src/engine/runner.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
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

  const byOpen = new Map(trades.map((t) => [t.openedAtMs, t]));
  return out.baseline.trades.map((bt) => {
    const paper = byOpen.get(bt.entryTs);
    return {
      tradeId: paper?.tradeId ?? `bt-${bt.entryTs}`,
      backtestPnlPct: ((bt.exitFillPrice - bt.entryFillPrice) / bt.entryFillPrice) * 100,
      paperPnlPct: paper ? Number(paper.pnlPct) : NaN,
    };
  });
}
