// P1-6 (SSRF via unvalidated callbackUrl) + P2-13 (period silently coerced) — submit-time validation.
// See CODE-REVIEW-2026-07-12.md.

import { describe, expect, it } from 'vitest';
import { AUTH, buildTestApp, runBody, testDeps } from './helpers';
import { assertSafeCallbackUrl, SubmitError } from '../src/jobs/submit.js';
import { periodMs } from '../src/jobs/worker.js';
import { RunnerError } from '../src/runner/errors.js';

// ─── P1-6: SSRF guard on the completion webhook URL (unit) ──────────────────
describe('assertSafeCallbackUrl (SSRF guard)', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1:9000/cb', // loopback
    'http://127.5.6.7/cb', // loopback /8
    'http://localhost:8080/cb',
    'https://sub.localhost/cb',
    'http://10.0.0.5/cb', // private
    'http://192.168.1.10/cb', // private
    'http://172.16.0.1/cb', // private /12
    'http://172.31.255.255/cb', // private /12 upper
    'http://0.0.0.0/cb',
    'http://[::1]:8080/cb', // IPv6 loopback
    'http://[fe80::1]/cb', // IPv6 link-local
    'http://[fd00::1]/cb', // IPv6 unique-local
    'http://[::ffff:127.0.0.1]/cb', // IPv4-mapped IPv6 loopback (Node normalizes → [::ffff:7f00:1])
    'http://[::ffff:7f00:1]/cb', // same, hex form
    'http://[0:0:0:0:0:ffff:127.0.0.1]/cb', // same, uncompressed
    'http://[::ffff:10.0.0.1]/cb', // IPv4-mapped IPv6 private
    'http://[::ffff:172.16.0.1]/cb', // IPv4-mapped IPv6 private /12
    'http://[::127.0.0.1]/cb', // deprecated IPv4-compatible IPv6 loopback (→ [::7f00:1])
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(() => assertSafeCallbackUrl(url)).toThrow(SubmitError);
    });
  }

  it('rejects a non-http(s) scheme', () => {
    expect(() => assertSafeCallbackUrl('file:///etc/passwd')).toThrow(SubmitError);
    expect(() => assertSafeCallbackUrl('gopher://internal/x')).toThrow(SubmitError);
  });

  it('rejects a non-URL string', () => {
    expect(() => assertSafeCallbackUrl('not a url')).toThrow(SubmitError);
  });

  const allowed = [
    'https://hook.example.com/cb',
    'http://hook.test/cb', // hostname literal — the existing completion-test callback
    'https://8.8.8.8/cb', // a public IP is fine
    'http://172.32.0.1/cb', // just outside the private /12 → allowed
    'http://[::ffff:8.8.8.8]/cb', // IPv4-mapped IPv6 of a PUBLIC address → allowed (no over-block)
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => assertSafeCallbackUrl(url)).not.toThrow();
    });
  }
});

// ─── P2-13/P2-21: worker.periodMs is the defense-in-depth backstop ──────────
// It must throw (not coerce to {0, MAX_SAFE_INTEGER}) on ANY invalid period, so a bad period can
// never reach an evidence scope window even if submit validation were bypassed.
describe('periodMs (defense-in-depth)', () => {
  it('returns parsed ms for a valid period', () => {
    const r = periodMs({ from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' });
    expect(r.tsFrom).toBe(Date.parse('2023-11-14T00:00:00.000Z'));
    expect(r.tsTo).toBe(Date.parse('2023-11-15T00:00:00.000Z'));
  });

  it('throws on an unparseable period (never coerces to {0, MAX})', () => {
    expect(() => periodMs({ from: 'not-a-date', to: 'also-bad' })).toThrow(RunnerError);
  });

  it('throws on an inverted period (from >= to)', () => {
    expect(() => periodMs({ from: '2023-11-15T00:00:00.000Z', to: '2023-11-14T00:00:00.000Z' })).toThrow(RunnerError);
    expect(() => periodMs({ from: '2023-11-14T00:00:00.000Z', to: '2023-11-14T00:00:00.000Z' })).toThrow(RunnerError);
  });
});

// ─── P1-6 + P2-13 wired into the submit path (HTTP) ─────────────────────────
describe('POST /v1/runs submit-time validation', () => {
  it('rejects an SSRF callbackUrl with 400 (P1-6)', async () => {
    const app = await buildTestApp({}, testDeps());
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'ssrf-1', callbackUrl: 'http://169.254.169.254/latest/meta-data/' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.dispose();
    }
  });

  it('rejects an unparseable period with 400 (P2-13)', async () => {
    const app = await buildTestApp({}, testDeps());
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'bad-period-1', period: { from: 'not-a-date', to: 'also-bad' } }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.dispose();
    }
  });

  it('rejects an inverted period (from >= to) with 400 (P2-13)', async () => {
    const app = await buildTestApp({}, testDeps());
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({
          runId: 'bad-period-2',
          period: { from: '2023-11-15T00:00:00.000Z', to: '2023-11-14T00:00:00.000Z' },
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.dispose();
    }
  });

  it('accepts a valid callbackUrl + period with 202 (no false positive)', async () => {
    const app = await buildTestApp({}, testDeps());
    try {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ runId: 'ok-1', callbackUrl: 'https://hook.example.com/cb' }),
      });
      expect(res.statusCode).toBe(202);
    } finally {
      await app.dispose();
    }
  });
});
