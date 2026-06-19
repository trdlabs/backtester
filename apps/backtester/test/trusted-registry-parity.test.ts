import { describe, expect, it } from 'vitest';
import { buildTrustedRegistry } from '../src/engine/trusted-registry';

describe('buildTrustedRegistry parity', () => {
  it('resolves the same trusted refs after the definition refactor', () => {
    const r = buildTrustedRegistry();
    expect(r.resolveStrategy({ id: 'short_after_pump', version: '0.1.0' })).toBeDefined();
    expect(r.resolveOverlay({ id: 'early_exit_short_after_pump', version: '0.1.0' })).toBeDefined();
    expect(r.resolveRiskProfile({ id: 'default_risk', version: '1.0.0' })).toBeDefined();
    expect(r.resolveExecutionProfile({ id: 'default_exec', version: '1.0.0' })).toBeDefined();
    expect(r.resolveStrategy({ id: 'nope', version: '0.0.0' })).toBeUndefined();
  });
});
