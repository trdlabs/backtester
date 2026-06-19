import type { ContentHash } from '../internal/shared-types';

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && CONTENT_HASH_RE.test(value);
}
