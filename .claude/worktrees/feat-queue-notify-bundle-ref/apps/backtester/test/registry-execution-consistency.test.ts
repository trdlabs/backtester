// Guards the single-source invariant: every module/profile that `/v1/registry` advertises (and every
// preset's refs) MUST resolve in the SAME registry the inline overlay worker executes against
// (`buildInlineOverlayRegistry`). If the worker hand-listed refs, this would drift — that is the bug
// this test exists to prevent. Deterministic (no Docker): both sides derive from
// TRUSTED_REGISTRY_DEFINITION, so a divergence is a pure resolution failure.

import { describe, expect, it } from 'vitest';
import { buildRegistryDescriptor } from '../src/api/registry-route';
import { buildInlineOverlayRegistry } from '../src/engine/trusted-registry';

describe('discovery ↔ inline execution consistency', () => {
  // The worker adds only the submitted overlay bundle on top of this; the trusted refs are fixed.
  const reg = buildInlineOverlayRegistry([]);
  const descriptor = buildRegistryDescriptor();

  it('advertises at least one runnable preset', () => {
    expect(descriptor.overlayRunPresets.length).toBeGreaterThan(0);
  });

  it('every preset ref resolves in the inline execution registry', () => {
    for (const p of descriptor.overlayRunPresets) {
      expect(reg.resolveStrategy(p.baselineRef), `baseline ${p.baselineRef.id}@${p.baselineRef.version}`).toBeDefined();
      expect(reg.resolveRiskProfile(p.riskProfileRef), `risk ${p.riskProfileRef.id}@${p.riskProfileRef.version}`).toBeDefined();
      expect(reg.resolveExecutionProfile(p.executionProfileRef), `exec ${p.executionProfileRef.id}@${p.executionProfileRef.version}`).toBeDefined();
    }
  });

  it('every advertised baseline / overlay / risk / exec ref resolves inline', () => {
    for (const b of descriptor.baselines) expect(reg.resolveStrategy(b), `baseline ${b.id}`).toBeDefined();
    for (const o of descriptor.overlays) expect(reg.resolveOverlay(o), `overlay ${o.id}`).toBeDefined();
    for (const r of descriptor.riskProfiles) expect(reg.resolveRiskProfile(r), `risk ${r.id}`).toBeDefined();
    for (const e of descriptor.execProfiles) expect(reg.resolveExecutionProfile(e), `exec ${e.id}`).toBeDefined();
  });
});
