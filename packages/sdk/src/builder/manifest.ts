import type { ModuleKind, ModuleManifest } from '../contracts/module';
import { BUNDLE_CONTRACT_VERSION } from '../internal/versions';

export interface CreateModuleManifestInput {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
}

/**
 * Build a frozen `ModuleManifest` with `bundleContractVersion` pinned to the SDK's
 * `BUNDLE_CONTRACT_VERSION`. Pure: same input => structurally identical manifest.
 */
export function createModuleManifest(input: CreateModuleManifestInput): ModuleManifest {
  return Object.freeze({
    id: input.id,
    version: input.version,
    kind: input.kind,
    bundleContractVersion: BUNDLE_CONTRACT_VERSION,
  });
}
