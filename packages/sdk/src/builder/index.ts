import type { ContentHash } from '../internal/shared-types';
import type { ModuleBundle } from '../contracts/module';
import { canonicalBundleHash } from '../contracts';

/**
 * Compute the content hash of an inline bundle locally, from its own fields — the same
 * registry-identity hash the service derives (`sandbox/bundle.ts::bundleHash`). "Inline"
 * distinguishes this from retrieving a pre-computed hash from the service registry; it does
 * not contact any service. Delegates to the shared `canonicalBundleHash` primitive so there
 * is exactly one hashing algorithm. (Distinct from the engine's sandbox-integrity
 * `computeBundleHash`, which hashes a materialized bundle directory.)
 */
export function computeInlineBundleHash(bundle: ModuleBundle): ContentHash {
  return canonicalBundleHash(bundle);
}

export { createModuleManifest } from './manifest';
export type { CreateModuleManifestInput } from './manifest';
export { createModuleBundle } from './bundle';
export type { CreateModuleBundleInput } from './bundle';
export { preflightValidateBundle, type PreflightOptions } from './preflight';
