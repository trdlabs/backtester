import type {
  Author,
  BundleManifest,
  CapabilityDeclaration,
  DataNeedsDeclaration,
  LifecycleHook,
  ModuleKind,
  ModuleStatus,
} from '../contracts/module';
import { API_CONTRACT_VERSION, BUNDLE_CONTRACT_VERSION } from '../internal/versions';

export interface CreateModuleManifestInput {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly summary: string;
  readonly rationale: string;
  readonly hooks: readonly LifecycleHook[];
  readonly paramsSchema: object;
  readonly capabilities: CapabilityDeclaration;
  readonly dataNeeds: DataNeedsDeclaration;
  readonly author?: Author;
  readonly status?: ModuleStatus;
  readonly params?: object;
  readonly source?: string;
  readonly targetStrategyRef?: string;
  readonly interceptionPoint?: string;
}

/**
 * Build a frozen bundle-layer manifest: the rich kernel manifest with `contractVersion` and
 * `bundleContractVersion` pinned to the SDK's contract constants. Pure: same input => structurally
 * identical manifest. `author` defaults to 'agent', `status` to 'research_only'.
 */
export function createModuleManifest(input: CreateModuleManifestInput): BundleManifest {
  return Object.freeze({
    id: input.id,
    version: input.version,
    kind: input.kind,
    name: input.name,
    summary: input.summary,
    rationale: input.rationale,
    author: input.author ?? 'agent',
    status: input.status ?? 'research_only',
    contractVersion: API_CONTRACT_VERSION,
    paramsSchema: input.paramsSchema,
    ...(input.params !== undefined ? { params: input.params } : {}),
    capabilities: input.capabilities,
    dataNeeds: input.dataNeeds,
    hooks: input.hooks,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.targetStrategyRef !== undefined ? { targetStrategyRef: input.targetStrategyRef } : {}),
    ...(input.interceptionPoint !== undefined ? { interceptionPoint: input.interceptionPoint } : {}),
    bundleContractVersion: BUNDLE_CONTRACT_VERSION,
  });
}
