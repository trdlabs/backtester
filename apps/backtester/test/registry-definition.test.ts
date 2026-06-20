import { describe, expect, it } from 'vitest';
import { TRUSTED_REGISTRY_DEFINITION, validateRegistryDefinition } from '../src/engine/registry-definition';

describe('TRUSTED_REGISTRY_DEFINITION', () => {
  it('is self-consistent (unique preset ids, resolvable refs, overlay-catalog metrics)', () => {
    expect(() => validateRegistryDefinition(TRUSTED_REGISTRY_DEFINITION)).not.toThrow();
    expect(TRUSTED_REGISTRY_DEFINITION.overlayRunPresets.length).toBeGreaterThan(0);
  });
  it('rejects a dangling preset baseline ref', () => {
    const bad = { ...TRUSTED_REGISTRY_DEFINITION, overlayRunPresets: [
      { id: 'x', baselineRef: { id: 'ghost', version: '9.9.9' },
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
        executionProfileRef: { id: 'default_exec', version: '1.0.0' }, metrics: ['pnl'] },
    ] };
    expect(() => validateRegistryDefinition(bad)).toThrow(/ghost/);
  });
});
