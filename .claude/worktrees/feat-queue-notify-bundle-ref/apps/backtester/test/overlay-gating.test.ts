import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTestApp, runBody, AUTH } from './helpers';
import type { AppHandles } from '../src/app';

describe('enableOverlayEngine flag', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableOverlayEngine).toBe(false);
  });
  it('is true only for exactly "true"', () => {
    expect(loadConfig({ BACKTESTER_ENABLE_OVERLAY_ENGINE: 'true' }).enableOverlayEngine).toBe(true);
    expect(loadConfig({ BACKTESTER_ENABLE_OVERLAY_ENGINE: '1' }).enableOverlayEngine).toBe(false);
    expect(loadConfig({ BACKTESTER_ENABLE_OVERLAY_ENGINE: 'false' }).enableOverlayEngine).toBe(false);
  });
});

describe('overlay pre-queue gating (engine off)', () => {
  let app: AppHandles | undefined;

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
  });

  it('rejects an overlay request with validation_error when the engine is OFF', async () => {
    app = await buildTestApp(); // enableOverlayEngine defaults to false in testConfig
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { ...runBody(), engine: 'overlay' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code ?? res.json().category).toBe('validation_error');
  });

  it('accepts a momentum request (no engine) when the engine is OFF', async () => {
    app = await buildTestApp();
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: runBody(),
    });
    expect(res.statusCode).toBe(202);
  });

  it('overlay request while disabled reports engine-disabled (not unknown_metric) regardless of metrics', async () => {
    app = await buildTestApp({ enableOverlayEngine: false });
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { ...runBody(), engine: 'overlay', metrics: ['definitely_not_a_metric'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_error');
    expect(res.json().message).toMatch(/overlay engine is disabled/i);
  });

  it('POST /v1/runs with a missing body returns 400 validation_error (not 500)', async () => {
    app = await buildTestApp();
    // No payload → req.body undefined. Pre-fix this hit the overlay gate's `body.engine` deref → TypeError → 500.
    const res = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: { ...AUTH } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code ?? res.json().category).toBe('validation_error');
  });

  it('POST /v1/runs with a non-object JSON body returns 400 validation_error (not 500)', async () => {
    app = await buildTestApp();
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code ?? res.json().category).toBe('validation_error');
  });
});
