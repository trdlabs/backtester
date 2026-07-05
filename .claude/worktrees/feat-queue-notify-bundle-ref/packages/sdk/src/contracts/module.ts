// Module contract types. The rich module manifest is re-sourced from the platform kernel
// (@trading-platform/sdk/research-contract) — single source, no drift (the path 042 took for the
// 017 contracts). The bundle layer adds `bundleContractVersion` on top of the kernel manifest.
export type {
  Author,
  CapabilityDeclaration,
  DataNeedsDeclaration,
  LifecycleHook,
  ModuleKind,
  ModuleManifest,
  ModuleStatus,
} from '@trading-platform/sdk/research-contract';

import type { ModuleManifest } from '@trading-platform/sdk/research-contract';

export type BacktestEngine = 'momentum' | 'overlay' | 'strategy';

/**
 * Bundle-layer manifest: the kernel module manifest plus the SDK bundle-wire-format version.
 * `bundleContractVersion` is a bundling concern the kernel does not own. It is DISTINCT from the
 * kernel's `contractVersion` (the 017 research-contract version) — do not conflate the two.
 */
export interface BundleManifest extends ModuleManifest {
  readonly bundleContractVersion: string;
}

export interface ModuleBundle {
  readonly manifest: BundleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}
