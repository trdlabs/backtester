// 018 — доверенный in-process registry (research R4, FR-002/028, contracts/runner-api.md §registry).
//
// Явная in-memory карта `id@version → модуль/профиль`. Резолв строго по ключу; ключ вне registry →
// провал прогона (runner возвращает `rejected`). БЕЗ dynamic load / импорта по сети/ФС / AST-сканов.

import type { ExecutionProfile, RiskProfile } from '@trading/research-contracts/research';
import type { HypothesisOverlayModule, StrategyModule } from '@trading/research-contracts/research';
import type { Ref } from '@trading/research-contracts/research';
import type { ResolvedOverlay, ResolvedStrategy } from './artifacts.js';

/** Доверенный реестр модулей и профилей; резолв по `id@version`. */
export interface TrustedModuleRegistry {
  resolveStrategy(ref: Ref): ResolvedStrategy | undefined;
  resolveOverlay(ref: Ref): ResolvedOverlay | undefined;
  resolveRiskProfile(ref: Ref): RiskProfile | undefined;
  resolveExecutionProfile(ref: Ref): ExecutionProfile | undefined;
}

/** Вход построителя registry. */
export interface RegistryInput {
  readonly strategies?: readonly StrategyModule[];
  readonly overlays?: readonly HypothesisOverlayModule[];
  readonly riskProfiles?: readonly RiskProfile[];
  readonly executionProfiles?: readonly ExecutionProfile[];
}

function key(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Построить доверенный registry из явных модулей/профилей (без побочных эффектов). */
export function createTrustedRegistry(input: RegistryInput): TrustedModuleRegistry {
  const strategies = new Map<string, ResolvedStrategy>();
  for (const m of input.strategies ?? []) {
    strategies.set(key(m.manifest.id, m.manifest.version), { module: m, manifest: m.manifest });
  }
  const overlays = new Map<string, ResolvedOverlay>();
  for (const m of input.overlays ?? []) {
    overlays.set(key(m.manifest.id, m.manifest.version), { module: m, manifest: m.manifest });
  }
  const riskProfiles = new Map<string, RiskProfile>();
  for (const p of input.riskProfiles ?? []) {
    riskProfiles.set(key(p.id, p.version), p);
  }
  const executionProfiles = new Map<string, ExecutionProfile>();
  for (const p of input.executionProfiles ?? []) {
    executionProfiles.set(key(p.id, p.version), p);
  }

  return {
    resolveStrategy: (ref) => strategies.get(key(ref.id, ref.version)),
    resolveOverlay: (ref) => overlays.get(key(ref.id, ref.version)),
    resolveRiskProfile: (ref) => riskProfiles.get(key(ref.id, ref.version)),
    resolveExecutionProfile: (ref) => executionProfiles.get(key(ref.id, ref.version)),
  };
}
