import { describe, expect, it } from 'vitest';
import { OVERLAY_EXAMPLE_BUNDLE, OVERLAY_EXAMPLE_SOURCE, preflightValidateBundle } from '../src/builder/index';

async function loadFactory(source: string): Promise<(p?: unknown) => any> {
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  const mod = await import(/* @vite-ignore */ url);
  return mod.default;
}

describe('overlay worked example', () => {
  it('passes preflight for the overlay engine', () => {
    const report = preflightValidateBundle(OVERLAY_EXAMPLE_BUNDLE, { engine: 'overlay' });
    expect(report.status).toBe('accepted');
  });

  it('apply returns a deterministic OverlayDecision', async () => {
    const factory = await loadFactory(OVERLAY_EXAMPLE_SOURCE);
    const mod = factory();
    const veto = mod.apply({ bar: { close: 100 }, params: { maxClose: 50 } });
    expect(veto.kind).toBe('veto');
    const pass = mod.apply({ bar: { close: 10 }, params: { maxClose: 50 } });
    expect(pass.kind).toBe('pass');
  });
});
