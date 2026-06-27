import { describe, expect, it } from 'vitest';
import { preflightValidateBundle, STRATEGY_EXAMPLE_BUNDLE, STRATEGY_EXAMPLE_SOURCE } from '../src/builder/index';

async function loadFactory(source: string): Promise<(p?: unknown) => any> {
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  const mod = await import(/* @vite-ignore */ url);
  return mod.default;
}

function makeCtx(over: Record<string, unknown> = {}) {
  const history = Array.from({ length: 20 }, (_, i) => ({ ts: i, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
  return {
    run: { runId: 'r', mode: 'test', seed: 1 },
    params: { lookback: 20, breakoutPct: 5, rsiPeriod: 14, rsiMax: 70, takePct: 10, stopPct: 5, dcaDrawdownPct: 3 },
    symbol: 'BTCUSDT',
    bar: { ts: 20, open: 100, high: 107, low: 100, close: 106, volume: 2000 },
    position: null,
    pendingIntent: null,
    portfolio: { equity: 1000, openPositions: 0 },
    clock: { now: () => 0 },
    data: { closedCandles: (n: number) => history.slice(-n), indicatorAsOf: () => undefined },
    indicators: { value: () => undefined, query: () => 50 },
    rng: { next: () => 0.5 },
    ...over,
  };
}

describe('strategy worked example', () => {
  it('passes preflight for the momentum engine', () => {
    const report = preflightValidateBundle(STRATEGY_EXAMPLE_BUNDLE, { engine: 'momentum' });
    expect(report.status).toBe('accepted');
  });

  it('manifest declares both lifecycle hooks', () => {
    expect(STRATEGY_EXAMPLE_BUNDLE.manifest.hooks).toEqual(['onBarClose', 'onPositionBar']);
  });

  it('onBarClose enters long on a breakout (deterministic)', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const d1 = mod.onBarClose(makeCtx());
    const d2 = mod.onBarClose(makeCtx());
    expect(d1).toEqual(d2);
    expect(d1.kind).toBe('enter');
    expect(d1.side).toBe('long');
  });

  it('onBarClose idles below the breakout threshold', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const d = mod.onBarClose(makeCtx({ bar: { ts: 20, open: 100, high: 101, low: 100, close: 101, volume: 2000 } }));
    expect(d.kind).toBe('idle');
  });

  it('onPositionBar exits at the take threshold', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const ctx = makeCtx({ position: { side: 'long', size: 1, entryPrice: 100 }, bar: { ts: 21, open: 110, high: 112, low: 109, close: 111, volume: 2000 } });
    const d = mod.onPositionBar(ctx);
    expect(d.kind).toBe('exit');
  });

  it('onPositionBar DCAs on a moderate drawdown', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const ctx = makeCtx({ position: { side: 'long', size: 1, entryPrice: 100 }, bar: { ts: 21, open: 97, high: 98, low: 96, close: 96.5, volume: 2000 } });
    const d = mod.onPositionBar(ctx);
    expect(d.kind).toBe('add_to_position');
    expect(d.mode).toBe('dca');
  });
});
