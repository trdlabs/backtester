import type { ModuleBundle } from '../../../contracts/module';
import { createModuleBundle } from '../../bundle';
import { createModuleManifest } from '../../manifest';

/**
 * Worked strategy: a long breakout entry with take/stop/DCA management. Self-contained ESM, no
 * imports, deterministic (only `ctx`). Mirrors a real multi-phase strategy (flat onBarClose +
 * in-position onPositionBar). This string is the raw ESM payload shipped in the bundle.
 */
export const STRATEGY_EXAMPLE_SOURCE = `// Self-contained strategy bundle (FR-003): no imports, pre-built ESM, deterministic.
// Entry convention: default-export a factory returning the lifecycle module.
export default function createStrategyModule() {
  return {
    // Flat phase: enter long on a lookback breakout, gated by RSI.
    onBarClose(ctx) {
      if (ctx.position) return { kind: 'idle' };
      const lookback = Number(ctx.params.lookback ?? 20);
      const history = ctx.data.closedCandles(lookback);
      if (history.length < lookback) return { kind: 'idle' };
      const past = history[0];
      const changePct = ((ctx.bar.close - past.close) / past.close) * 100;
      const breakoutPct = Number(ctx.params.breakoutPct ?? 5);
      const rsi = ctx.indicators.query({ name: 'rsi', params: { period: Number(ctx.params.rsiPeriod ?? 14) } });
      const rsiMax = Number(ctx.params.rsiMax ?? 70);
      const rsiOk = typeof rsi !== 'number' || rsi <= rsiMax;
      if (changePct >= breakoutPct && rsiOk) {
        const stopPct = Number(ctx.params.stopPct ?? 5);
        const takePct = Number(ctx.params.takePct ?? 10);
        const parts = ['breakout ' + changePct.toFixed(1) + '% >= ' + breakoutPct + '%'];
        if (typeof rsi === 'number') parts.push('RSI=' + rsi.toFixed(1));
        return {
          kind: 'enter',
          side: 'long',
          stop: ctx.bar.close * (1 - stopPct / 100),
          take: ctx.bar.close * (1 + takePct / 100),
          rationale: parts.join('; '),
        };
      }
      return { kind: 'idle' };
    },
    // Management phase: take-profit / stop-loss / DCA on drawdown.
    onPositionBar(ctx) {
      const pos = ctx.position;
      if (!pos) return { kind: 'idle' };
      const pnlPct = ((ctx.bar.close - pos.entryPrice) / pos.entryPrice) * 100;
      const takePct = Number(ctx.params.takePct ?? 10);
      const stopPct = Number(ctx.params.stopPct ?? 5);
      const dcaDrawdownPct = Number(ctx.params.dcaDrawdownPct ?? 3);
      if (pnlPct >= takePct) return { kind: 'exit', target: 'all', reason: 'take ' + pnlPct.toFixed(1) + '%' };
      if (pnlPct <= -stopPct) return { kind: 'exit', target: 'all', reason: 'stop ' + pnlPct.toFixed(1) + '%' };
      if (pnlPct <= -dcaDrawdownPct) return { kind: 'add_to_position', mode: 'dca' };
      return { kind: 'idle' };
    },
  };
}
`;

export const STRATEGY_EXAMPLE_BUNDLE: ModuleBundle = createModuleBundle({
  manifest: createModuleManifest({
    id: 'example_long_breakout',
    version: '0.1.0',
    kind: 'strategy',
    name: 'Long breakout (worked example)',
    summary: 'Long entry on a lookback breakout with take/stop/DCA management.',
    rationale: 'Demonstrates a multi-phase strategy bundle: flat-phase entry + in-position management.',
    hooks: ['onBarClose', 'onPositionBar'],
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lookback: { type: 'number' },
        breakoutPct: { type: 'number' },
        rsiPeriod: { type: 'number' },
        rsiMax: { type: 'number' },
        takePct: { type: 'number' },
        stopPct: { type: 'number' },
        dcaDrawdownPct: { type: 'number' },
      },
    },
    params: { lookback: 20, breakoutPct: 5, rsiPeriod: 14, rsiMax: 70, takePct: 10, stopPct: 5, dcaDrawdownPct: 3 },
  }),
  entry: 'module/index.js',
  files: { 'module/index.js': STRATEGY_EXAMPLE_SOURCE },
});
