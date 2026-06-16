// Content hashing on top of canonical JSON. `contentRef(payload)` is the artifact id and the basis
// for `result_hash` / `dataset_fingerprint` — the verifiable determinism & parity primitives.

import { createHash } from 'node:crypto';
import type { ContentHash } from '@trading/research-contracts';
import { canonicalJson } from './canonical-json';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `sha256:<hex>` of the canonical-JSON encoding of `payload` (payload-only — no host context). */
export function contentRef(payload: unknown): ContentHash {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}
