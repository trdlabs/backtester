import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { ExecutionProfile, StrategyModule, CanonicalRowV2 } from '@trading/research-contracts/research';

// Five 1m bars; a strategy enters long on bar index 1 (close 115) and exits on bar index 3 (close 135).
const TS0 = 1_781_740_800_000;
const rows: CanonicalRowV2[] = [100, 110, 120, 130, 140].map((px, i) => ({
  schema_version: 2, minute_ts: TS0 + i * 60_000, symbol: 'TST',
  open: px, high: px + 1, low: px - 1, close: px + 5, volume: 1000,
} as unknown as CanonicalRowV2));

// Base the manifest on a known-valid 017 strategy manifest (paramsSchema/contractVersion/etc.), overriding
// only id/version/name/hooks — a hand-built minimal manifest fails 017 module validation in runBacktest.
const replayMod: StrategyModule = {
  manifest: { ...shortAfterPump.manifest, id: 'replay', version: '1.0.0', name: 'replay', hooks: ['onBarClose', 'onPositionBar'] },
  onBarClose: (ctx: any) => (ctx.bar.ts === TS0 + 1 * 60_000 ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
  onPositionBar: (ctx: any) => (ctx.bar.ts === TS0 + 3 * 60_000 ? { kind: 'exit', target: 'replay' } : { kind: 'idle' }),
} as unknown as StrategyModule;

const SAME_BAR_EXEC: ExecutionProfile = {
  id: 'same_bar', version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 }, slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const req: BacktestRunRequest = {
  runId: 'sbc-1', mode: 'research', moduleRef: { id: 'replay', version: '1.0.0' },
  datasetRef: 'tst', symbols: ['TST'], timeframe: '1m',
  period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + 5 * 60_000).toISOString() },
  riskProfileRef: { id: 'default_risk', version: '1.0.0' },
  executionProfileRef: { id: 'same_bar', version: '1.0.0' }, seed: 1, metrics: ['pnl'],
} as unknown as BacktestRunRequest;

describe('same_bar_close fill model', () => {
  it('fills enter/exit at the decision bar close', async () => {
    const built = marketTapeFromCanonicalRows('tst', '1m', rows);
    if (!built.ok) throw new Error(built.detail);
    const registry = createModuleRegistry({ strategies: [replayMod], riskProfiles: [DEFAULT_RISK], executionProfiles: [SAME_BAR_EXEC] });
    const out = await runBacktest(req, { registry, marketTape: built.tape, router: createTrustedRouter() });
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    const trades = out.baseline.trades;
    expect(trades.length).toBe(1);
    expect(trades[0].entryFillPrice).toBe(115); // close of bar index 1
    expect(trades[0].exitFillPrice).toBe(135);  // close of bar index 3
    const pnlPct = (trades[0].exitFillPrice - trades[0].entryFillPrice) / trades[0].entryFillPrice * 100;
    expect(pnlPct).toBeCloseTo((135 - 115) / 115 * 100, 9);
  });
});
