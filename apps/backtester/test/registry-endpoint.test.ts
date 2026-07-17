import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegistryDescriptor } from '@trdlabs/backtester-sdk/contracts';
import type { AppHandles } from '../src/app';
import { AUTH, buildTestApp } from './helpers';

describe('GET /v1/registry', () => {
  let app: AppHandles;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.dispose();
  });

  it('returns the trusted registry descriptor', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/registry',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RegistryDescriptor;

    // contractVersion present
    expect(typeof body.contractVersion).toBe('string');
    expect(body.contractVersion.length).toBeGreaterThan(0);

    // baselines includes the example strategy
    expect(body.baselines.map((b) => b.id)).toContain('short_after_pump');

    // overlays includes the example overlay
    expect(body.overlays.map((o) => o.id)).toContain('early_exit_short_after_pump');

    // risk + exec profiles
    expect(body.riskProfiles.map((p) => p.id)).toContain('default_risk');
    expect(body.execProfiles.map((p) => p.id)).toContain('default_exec');

    // metric catalogs
    expect(Array.isArray(body.metricCatalogs.momentum)).toBe(true);
    expect(body.metricCatalogs.momentum.length).toBeGreaterThan(0);
    expect(Array.isArray(body.metricCatalogs.overlay)).toBe(true);
    expect(body.metricCatalogs.overlay).toContain('pnl');

    // presets
    expect(body.overlayRunPresets.length).toBeGreaterThan(0);
    const preset = body.overlayRunPresets[0]!;
    expect(preset.baselineRef).toEqual({ id: 'short_after_pump', version: expect.any(String) });
    // baselineRef is a pure Ref — no name/summary
    expect((preset.baselineRef as unknown as Record<string, unknown>).name).toBeUndefined();
    expect(preset.riskProfileRef.id).toBe('default_risk');
    expect(preset.executionProfileRef.id).toBe('default_exec');
    expect(preset.metrics).toContain('pnl');
  });

  it('rejects requests without a bearer token with 401', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/registry',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong bearer token with 401', async () => {
    const res = await app.server.inject({
      method: 'GET',
      url: '/v1/registry',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
