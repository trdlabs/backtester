import type { Ref } from './run';

/** A registered module/profile, with optional display metadata (NOT sent in a run request). */
export interface RegisteredModuleRef {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly summary?: string;
}

/**
 * A complete, internally-consistent overlay-run recipe. Selected by `id`; the consumer applies its
 * own submitted overlay bundle on top of `baselineRef`. The refs are pure `Ref` (no name/summary)
 * so they drop straight into the run request without shifting its fingerprint.
 */
export interface OverlayRunPreset {
  readonly id: string;
  readonly name?: string;
  readonly baselineRef: Ref;
  readonly riskProfileRef: Ref;
  readonly executionProfileRef: Ref;
  readonly metrics: readonly string[];
}

export interface RegistryDescriptor {
  readonly contractVersion: string; // = API_CONTRACT_VERSION; the registry shape is additive
  readonly baselines: readonly RegisteredModuleRef[];
  readonly overlays: readonly RegisteredModuleRef[];
  readonly riskProfiles: readonly RegisteredModuleRef[];
  readonly execProfiles: readonly RegisteredModuleRef[];
  readonly metricCatalogs: {
    readonly momentum: readonly string[];
    readonly overlay: readonly string[];
  };
  readonly overlayRunPresets: readonly OverlayRunPreset[];
}
