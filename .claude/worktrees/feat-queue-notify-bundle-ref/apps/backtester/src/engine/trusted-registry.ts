import { createTrustedRegistry, type TrustedModuleRegistry } from './registry.js';
import { TRUSTED_REGISTRY_DEFINITION } from './registry-definition.js';
import { createModuleRegistry, type ModuleRegistry019 } from './sandbox/routing.js';
import type { ModuleBundle } from './sandbox/bundle.js';

/** The fixed trusted registry for the 6a overlay path, built from the canonical definition. */
export function buildTrustedRegistry(): TrustedModuleRegistry {
  return createTrustedRegistry({
    strategies: [...TRUSTED_REGISTRY_DEFINITION.strategies],
    overlays: [...TRUSTED_REGISTRY_DEFINITION.overlays],
    riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
    executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
  });
}

/**
 * The inline overlay-EXECUTION registry: the SAME canonical trusted modules/profiles that
 * `/v1/registry` advertises (via {@link TRUSTED_REGISTRY_DEFINITION}), plus the untrusted overlay
 * bundle(s) submitted with the run. Single source of truth — keeps discovery and execution from
 * drifting (the worker must NOT hand-list refs).
 *
 * `strategyBundles` (default `[]`) wires in submitted strategy bundles so they resolve with
 * `provenance:'bundle'` — the trusted strategies remain available as the single-arg fallback.
 * Caller must pass an empty array for the first param when only wiring strategy bundles.
 */
export function buildInlineOverlayRegistry(
  overlayBundles: readonly ModuleBundle[],
  strategyBundles: readonly ModuleBundle[] = [],
): ModuleRegistry019 {
  return createModuleRegistry({
    strategies: [...TRUSTED_REGISTRY_DEFINITION.strategies],
    strategyBundles: [...strategyBundles],
    overlays: [...TRUSTED_REGISTRY_DEFINITION.overlays],
    overlayBundles: [...overlayBundles],
    riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
    executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
  });
}
