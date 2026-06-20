import { describe, expect, expectTypeOf, it } from 'vitest';
import { SDK_VERSION, API_CONTRACT_VERSION } from '../src/contracts/index';
import type { RegistryDescriptor, OverlayRunPreset, RegisteredModuleRef, Ref } from '../src/contracts/index';

describe('registry discovery contract', () => {
  it('bumps the package SDK version but not the API contract version', () => {
    expect(SDK_VERSION).toBe('0.2.0');
    expect(API_CONTRACT_VERSION).toBe('017.2');
  });
  it('preset refs are pure Ref (no name/summary leak into the request)', () => {
    expectTypeOf<OverlayRunPreset['baselineRef']>().toEqualTypeOf<Ref>();
    expectTypeOf<OverlayRunPreset['riskProfileRef']>().toEqualTypeOf<Ref>();
    expectTypeOf<OverlayRunPreset['executionProfileRef']>().toEqualTypeOf<Ref>();
  });
  it('descriptor carries per-engine catalogs and presets', () => {
    expectTypeOf<RegistryDescriptor['metricCatalogs']['overlay']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<RegistryDescriptor['overlayRunPresets']>().toEqualTypeOf<readonly OverlayRunPreset[]>();
    expectTypeOf<RegistryDescriptor['baselines'][number]>().toEqualTypeOf<RegisteredModuleRef>();
  });
});
