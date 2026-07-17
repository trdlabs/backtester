import type { RegistryDescriptor, RegisteredModuleRef } from '@trdlabs/backtester-sdk/contracts';
import { API_CONTRACT_VERSION } from '@trdlabs/backtester-sdk/contracts';
import { TRUSTED_REGISTRY_DEFINITION as D } from '../engine/registry-definition.js';

function toRef(r: { id: string; version: string; name?: string; summary?: string }): RegisteredModuleRef {
  return {
    id: r.id,
    version: r.version,
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.summary !== undefined ? { summary: r.summary } : {}),
  };
}

export function buildRegistryDescriptor(): RegistryDescriptor {
  return {
    contractVersion: API_CONTRACT_VERSION,
    baselines: D.strategies.map((s) => toRef(s.manifest)),
    overlays: D.overlays.map((o) => toRef(o.manifest)),
    riskProfiles: D.riskProfiles.map((p) => toRef(p)),
    execProfiles: D.executionProfiles.map((p) => toRef(p)),
    metricCatalogs: {
      momentum: [...D.momentumMetricCatalog],
      overlay: [...D.overlayMetricCatalog],
    },
    overlayRunPresets: D.overlayRunPresets.map((p) => ({
      id: p.id,
      ...(p.name !== undefined ? { name: p.name } : {}),
      baselineRef: { id: p.baselineRef.id, version: p.baselineRef.version },
      riskProfileRef: { id: p.riskProfileRef.id, version: p.riskProfileRef.version },
      executionProfileRef: { id: p.executionProfileRef.id, version: p.executionProfileRef.version },
      metrics: [...p.metrics],
    })),
  };
}
