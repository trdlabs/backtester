import type { ContentHash } from '../internal/shared-types';
import type { ModuleBundle } from '../contracts/module';
import { canonicalBundleHash, sha256HexBytes } from '../internal/content-hash';

/**
 * Internal structural identity (backtester sandbox-registry only): hashes the canonical JSON of
 * `{ manifest, entry, files }`. Same bundle => same hash. Distinct from the engine's
 * sandbox-integrity `computeBundleHash`, which hashes a materialized bundle directory.
 */
export function computeInlineBundleHash(bundle: ModuleBundle): ContentHash {
  return canonicalBundleHash(bundle);
}

/**
 * Cross-boundary pin: sha256 over the RAW ESM bytes, returns 'sha256:<hex>'. This is the hash that
 * goes into evidence.bundleHash and the platform bot_bundle.contentHash. It deliberately accepts
 * ONLY raw bytes (not a ModuleBundle) so it cannot be confused with computeInlineBundleHash.
 */
export function computeBundleHash(rawBytes: Buffer | Uint8Array): ContentHash {
  return `sha256:${sha256HexBytes(rawBytes)}`;
}
