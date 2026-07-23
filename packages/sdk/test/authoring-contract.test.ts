import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LifecycleModule,
  MomentumSignals,
  OverlayLifecycleModule,
  StrategyContext,
} from '../src/contracts/index';
import { allSchemaAssets, SCHEMA_IDS } from '../src/contracts/index';
import { API_CONTRACT_VERSION } from '../src/contracts/index';
// Imported by RELATIVE SOURCE PATH (not the package specifier) so the public SDK package.json
// carries NO dependency on the private @trading/research-contracts package. This is a temporary
// coexistence parity guard, deleted after the trading-lab cutover.
import { allSchemaAssets as privateAllSchemaAssets } from '../../research-contracts/src/research/index';
import { CONTRACT_VERSION } from '../../research-contracts/src/index';

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
  // Count is derived from the kernel's own SCHEMA_IDS, not a literal. A hardcoded five broke the
  // moment the kernel grew a schema (sdk 0.13.0 added four) — and it was asserting nothing the
  // $id comparison below does not already assert more precisely.
  it('loads every kernel asset, and their $ids match SCHEMA_IDS exactly', () => {
    const assets = allSchemaAssets();
    expect(assets.length).toBe(Object.keys(SCHEMA_IDS).length);
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
