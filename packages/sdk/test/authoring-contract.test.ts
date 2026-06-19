import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LifecycleModule,
  MomentumSignals,
  OverlayLifecycleModule,
  StrategyContext,
} from '../src/contracts/index';
import { allSchemaAssets, SCHEMA_IDS } from '../src/contracts/index';
import { API_CONTRACT_VERSION } from '../src/contracts/index';
import { allSchemaAssets as privateAllSchemaAssets } from '@trading/research-contracts/research';
import { CONTRACT_VERSION } from '@trading/research-contracts';

describe('authoring ABI', () => {
  it('types the momentum function', () => {
    expectTypeOf<MomentumSignals>().toBeFunction();
  });
  it('requires apply on overlay modules', () => {
    const overlay: OverlayLifecycleModule = { apply: () => null };
    expect(typeof overlay.apply).toBe('function');
  });
  it('permits optional lifecycle hooks', () => {
    const module: LifecycleModule = {
      onBarClose: (_ctx: StrategyContext) => null,
      init: () => undefined,
      dispose: () => undefined,
    };
    expect(typeof module.onBarClose).toBe('function');
  });
});

describe('017 schema assets', () => {
  it('loads all five assets whose $id matches SCHEMA_IDS', () => {
    const assets = allSchemaAssets();
    expect(assets.length).toBe(5);
    const ids = assets.map((a) => a.$id).sort();
    expect(ids).toEqual(Object.values(SCHEMA_IDS).sort());
  });

  it('SDK schema assets are deep-equal to the private research-contracts copies', () => {
    const byId = (arr: readonly Record<string, unknown>[]) =>
      [...arr].sort((a, b) => String(a.$id).localeCompare(String(b.$id)));
    const sdkAssets = byId(allSchemaAssets());
    const privateAssets = byId(privateAllSchemaAssets());
    expect(sdkAssets.length).toBe(privateAssets.length);
    expect(sdkAssets).toEqual(privateAssets);
  });
});

describe('version parity', () => {
  it('API_CONTRACT_VERSION matches research-contracts CONTRACT_VERSION', () => {
    expect(API_CONTRACT_VERSION).toBe(CONTRACT_VERSION);
  });
});
