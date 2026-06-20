import { METRIC_CATALOG as MOMENTUM_METRIC_CATALOG } from '@trading/research-contracts';
import { METRIC_CATALOG as OVERLAY_METRIC_CATALOG } from '@trading/research-contracts/research';
import { DEFAULT_RISK, DEFAULT_EXEC } from './profiles.js';
import { shortAfterPump } from './examples/short-after-pump.strategy.js';
import { earlyExitShortAfterPump } from './examples/early-exit-short-after-pump.overlay.js';
import type {
  StrategyModule,
  HypothesisOverlayModule,
  RiskProfile,
  ExecutionProfile,
} from '@trading/research-contracts/research';

export interface OverlayRunPresetDef {
  readonly id: string;
  readonly name?: string;
  readonly baselineRef: { id: string; version: string };
  readonly riskProfileRef: { id: string; version: string };
  readonly executionProfileRef: { id: string; version: string };
  readonly metrics: readonly string[];
}

// Use the GENERAL contract types (matching `RegistryInput` in engine/registry.ts) so the definition
// accepts any registered module/profile, not just the current example concretes.
export interface RegistryDefinition {
  readonly strategies: readonly StrategyModule[];
  readonly overlays: readonly HypothesisOverlayModule[];
  readonly riskProfiles: readonly RiskProfile[];
  readonly executionProfiles: readonly ExecutionProfile[];
  readonly momentumMetricCatalog: readonly string[];
  readonly overlayMetricCatalog: readonly string[];
  readonly overlayRunPresets: readonly OverlayRunPresetDef[];
}

export const TRUSTED_REGISTRY_DEFINITION: RegistryDefinition = {
  strategies: [shortAfterPump],
  overlays: [earlyExitShortAfterPump],
  riskProfiles: [DEFAULT_RISK],
  executionProfiles: [DEFAULT_EXEC],
  momentumMetricCatalog: MOMENTUM_METRIC_CATALOG,
  overlayMetricCatalog: OVERLAY_METRIC_CATALOG,
  overlayRunPresets: [
    {
      id: 'default-overlay',
      name: 'Default overlay run (short_after_pump baseline)',
      baselineRef: { id: shortAfterPump.manifest.id, version: shortAfterPump.manifest.version },
      riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
      executionProfileRef: { id: DEFAULT_EXEC.id, version: DEFAULT_EXEC.version },
      // The full advertised overlay catalog: a preset is a COMPLETE, self-sufficient run scaffold, so
      // a consumer that submits against it gets every metric the research comparison/evaluation needs
      // (total_trades / profit_factor / top_trade_contribution_pct) without having to ask for more.
      metrics: [...OVERLAY_METRIC_CATALOG],
    },
  ],
};

/** Fail-fast: dup preset ids, dangling refs, empty/non-overlay-catalog metrics. */
export function validateRegistryDefinition(def: RegistryDefinition): void {
  const k = (r: { id: string; version: string }) => `${r.id}@${r.version}`;
  const strategies = new Set(def.strategies.map((s) => k(s.manifest)));
  const risks = new Set(def.riskProfiles.map(k));
  const execs = new Set(def.executionProfiles.map(k));
  const overlay = new Set(def.overlayMetricCatalog);
  const ids = new Set<string>();
  for (const p of def.overlayRunPresets) {
    if (ids.has(p.id)) throw new Error(`registry: duplicate preset id ${p.id}`);
    ids.add(p.id);
    if (!strategies.has(k(p.baselineRef))) throw new Error(`registry: preset ${p.id} baselineRef ${k(p.baselineRef)} not registered`);
    if (!risks.has(k(p.riskProfileRef))) throw new Error(`registry: preset ${p.id} riskProfileRef ${k(p.riskProfileRef)} not registered`);
    if (!execs.has(k(p.executionProfileRef))) throw new Error(`registry: preset ${p.id} executionProfileRef ${k(p.executionProfileRef)} not registered`);
    if (p.metrics.length === 0) throw new Error(`registry: preset ${p.id} has empty metrics`);
    for (const m of p.metrics) if (!overlay.has(m)) throw new Error(`registry: preset ${p.id} metric ${m} not in overlay catalog`);
  }
}

validateRegistryDefinition(TRUSTED_REGISTRY_DEFINITION);
