// P2-10 (no usable default auth secret on an externally-reachable bind) + P2-11 (constant-time bearer
// comparison). See CODE-REVIEW-2026-07-12.

import { describe, expect, it } from 'vitest';
import { bearerTokenMatches } from '../src/api/bearer-auth.js';
import { loadConfig } from '../src/config.js';

describe('P2-11: bearerTokenMatches (constant-time)', () => {
  it('accepts the exact "Bearer <token>" header', () => {
    expect(bearerTokenMatches('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(bearerTokenMatches('Bearer nope', 's3cret')).toBe(false);
  });

  it('rejects a header of a different length (no length-based early-out / throw)', () => {
    expect(bearerTokenMatches('Bearer s3cret-extra', 's3cret')).toBe(false);
    expect(bearerTokenMatches('Bearer s', 's3cret')).toBe(false);
  });

  it('rejects a missing / malformed / non-string header', () => {
    expect(bearerTokenMatches(undefined, 's3cret')).toBe(false);
    expect(bearerTokenMatches('', 's3cret')).toBe(false);
    expect(bearerTokenMatches('s3cret', 's3cret')).toBe(false); // missing "Bearer " prefix
    expect(bearerTokenMatches('Basic s3cret', 's3cret')).toBe(false);
  });
});

describe('P2-10: auth token must not default to an insecure value on a non-loopback bind', () => {
  it('throws when BACKTESTER_HOST is non-loopback and BACKTESTER_AUTH_TOKEN is unset', () => {
    expect(() => loadConfig({ BACKTESTER_HOST: '0.0.0.0' })).toThrow(/BACKTESTER_AUTH_TOKEN/);
  });

  it('throws when the host is a concrete external address and the token is unset', () => {
    expect(() => loadConfig({ BACKTESTER_HOST: '10.0.0.5' })).toThrow(/BACKTESTER_AUTH_TOKEN/);
  });

  it('does NOT throw on a non-loopback host when the token is explicitly set', () => {
    expect(() => loadConfig({ BACKTESTER_HOST: '0.0.0.0', BACKTESTER_AUTH_TOKEN: 'secret' })).not.toThrow();
    expect(loadConfig({ BACKTESTER_HOST: '0.0.0.0', BACKTESTER_AUTH_TOKEN: 'secret' }).authToken).toBe('secret');
  });

  it('allows the dev default on a loopback host (127.0.0.1 / localhost / ::1)', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.9']) {
      expect(() => loadConfig({ BACKTESTER_HOST: host })).not.toThrow();
    }
    expect(loadConfig({}).authToken).toBe('dev-token'); // default host is loopback
  });
});
