import { createTrustedRegistry, type TrustedModuleRegistry } from './registry.js';
import { DEFAULT_RISK, DEFAULT_EXEC } from './profiles.js';
import { shortAfterPump } from './examples/short-after-pump.strategy.js';
import { earlyExitShortAfterPump } from './examples/early-exit-short-after-pump.overlay.js';

/** The fixed trusted registry for the 6a overlay path (example modules + default profiles). Untrusted bundles are 6b. */
export function buildTrustedRegistry(): TrustedModuleRegistry {
  return createTrustedRegistry({
    strategies: [shortAfterPump],
    overlays: [earlyExitShortAfterPump],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [DEFAULT_EXEC],
  });
}
