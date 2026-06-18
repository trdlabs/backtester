import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ValidationReport } from '@trading/research-contracts';
import { BUNDLE_CONTRACT_VERSION } from '@trading/research-contracts';
import type { AppHandles } from '../src/app';
import { AUTH, buildTestApp, runBody } from './helpers';

let app: AppHandles;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.dispose(); });

// ── /v1/modules/validate ─────────────────────────────────────────────────────

describe('POST /v1/modules/validate', () => {
  it('returns 400 when body is malformed JSON', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: 'not-json-object',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('rejects when body is a JSON non-object (number)', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify(42),
    });
    const report = res.json<ValidationReport>();
    expect(report.status).toBe('rejected');
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.executed).toBe(false);
  });

  it('rejects when moduleBundle has missing manifest', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { moduleBundle: {} },
    });
    const report = res.json<ValidationReport>();
    expect(report.status).toBe('rejected');
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.executed).toBe(false);
  });

  it('rejects when moduleBundle has invalid entry path', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        moduleBundle: {
          manifest: { id: 'b', version: '1.0.0', kind: 'strategy', bundleContractVersion: BUNDLE_CONTRACT_VERSION },
          entry: '../evil.mjs',
          files: { '../evil.mjs': 'export function signals(c){ return []; }' },
        },
      },
    });
    const report = res.json<ValidationReport>();
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
    expect(report.executed).toBe(false);
  });

  it('accepts a valid inline bundle', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        moduleBundle: {
          manifest: { id: 'b', version: '1.0.0', kind: 'strategy', bundleContractVersion: BUNDLE_CONTRACT_VERSION },
          entry: 'module.mjs',
          files: { 'module.mjs': 'export function signals(c){ return c.map(()=>false); }' },
        },
      },
    });
    const report = res.json<ValidationReport>();
    expect(report.status).toBe('accepted');
    expect(report.issues).toEqual([]);
    expect(report.executed).toBe(false);
  });

  it('returns accepted with no issues when body has no moduleBundle', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/modules/validate',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {},
    });
    const report = res.json<ValidationReport>();
    expect(report.status).toBe('accepted');
    expect(report.executed).toBe(false);
  });
});

// ── POST /v1/runs — field validation coverage ─────────────────────────────────

describe('POST /v1/runs — validation errors', () => {
  it('rejects empty body with 400 validation_error', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('rejects missing datasetRef with 400 validation_error', async () => {
    const { datasetRef: _omit, ...noDataset } = runBody();
    const res = await app.server.inject({
      method: 'POST', url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: noDataset,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_error');
  });

  it('rejects invalid mode with 400 validation_error', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: runBody({ mode: 'invalid' as never }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_error');
  });

  it('rejects unknown metric with 400 validation_error', async () => {
    const res = await app.server.inject({
      method: 'POST', url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: runBody({ metrics: ['not_a_real_metric'] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_error');
  });

  it('rejects missing moduleRef with 400 validation_error', async () => {
    const { moduleRef: _omit, ...noRef } = runBody();
    const res = await app.server.inject({
      method: 'POST', url: '/v1/runs',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: noRef,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_error');
  });
});
