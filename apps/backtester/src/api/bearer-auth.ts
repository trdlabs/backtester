// P2-11 — constant-time bearer-token check shared by the run API (api/server.ts) and the data API
// (data/data-api-server.ts), so the two can't drift. A plain `header !== \`Bearer ${token}\`` compare
// short-circuits on the first differing byte, leaking token bytes (and length) through timing.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * True iff `authorizationHeader` is exactly `Bearer <expectedToken>`, compared in constant time.
 * Both sides are hashed to a fixed 32-byte SHA-256 digest first: `timingSafeEqual` requires
 * equal-length buffers, and hashing normalizes length so neither the token value NOR its length leaks
 * via comparison timing (the only input-dependent work left is the hash itself, which does not reveal
 * how many leading bytes matched).
 */
export function bearerTokenMatches(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (typeof authorizationHeader !== 'string') return false;
  const got = createHash('sha256').update(authorizationHeader).digest();
  const want = createHash('sha256').update(`Bearer ${expectedToken}`).digest();
  return timingSafeEqual(got, want);
}
