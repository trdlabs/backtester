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
import { SUPPORTED_CONTRACT_VERSIONS } from '../../research-contracts/src/research/catalogs';

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
  // Раньше здесь стояло строгое равенство с research CONTRACT_VERSION. Оно держалось, пока обе
  // величины двигались вместе, — но это две РАЗНЫЕ оси: API_CONTRACT_VERSION версионирует wire-API
  // backtester-сервиса, а research CONTRACT_VERSION — конверт манифеста. 083 E1 бампнул второй
  // (`lifecycle`/`onEvent`), не тронув первый: HTTP-поверхность этого пакета не изменилась.
  //
  // Настоящий инвариант — не равенство, а СОВМЕСТИМОСТЬ: версия, которую объявляет наш API, обязана
  // оставаться в наборе, который kernel принимает. Иначе сервис объявлял бы контракт, по которому
  // его собственный валидатор отказывается работать.
  //
  // Поднять API_CONTRACT_VERSION до 017.3 — отдельное решение и отдельный релиз
  // @trdlabs/backtester-sdk; в rollout kernel'а 0.13.0 этот пакет намеренно не трогается.
  it('API_CONTRACT_VERSION stays within the kernel-supported set', () => {
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toContain(API_CONTRACT_VERSION);
  });

  it('research CONTRACT_VERSION is the newest supported version', () => {
    const supported = [...SUPPORTED_CONTRACT_VERSIONS];
    expect(supported[supported.length - 1]).toBe(CONTRACT_VERSION);
  });
});
