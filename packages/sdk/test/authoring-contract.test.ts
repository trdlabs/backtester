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
  // Что здесь на самом деле проверяется — СОВМЕСТИМОСТЬ AUTHORING-ДЕФОЛТА, а не равенство двух
  // version axes.
  //
  // `createModuleManifest` (builder/manifest.ts) проставляет в манифест `contractVersion:
  // API_CONTRACT_VERSION`, то есть каждый бандл, собранный этим пакетом, объявляет `017.2`. Значит
  // инвариант такой: версия, которую эмитит наш builder, обязана оставаться в наборе, который
  // kernel принимает. Иначе пакет authoring'а штамповал бы бандлы, которые kernel-валидатор
  // отвергает — и ломался бы не он, а его пользователи.
  //
  // Строгое равенство с research `CONTRACT_VERSION` держалось, пока обе величины двигались вместе,
  // но оси разные: research-версия версионирует КОНВЕРТ МАНИФЕСТА, а `API_CONTRACT_VERSION` —
  // wire-API сервиса. 083 E1 бампнул первую (`lifecycle`/`onEvent`) и не тронул вторую.
  //
  // Поднять authoring-дефолт до `017.3` — отдельное решение и отдельный релиз
  // @trdlabs/backtester-sdk; в rollout kernel'а 0.13.0 пакет не переиздавался.
  it('the authoring default this package emits stays kernel-acceptable', () => {
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toContain(API_CONTRACT_VERSION);
  });

  it('research CONTRACT_VERSION is the newest supported version', () => {
    const supported = [...SUPPORTED_CONTRACT_VERSIONS];
    expect(supported[supported.length - 1]).toBe(CONTRACT_VERSION);
  });
});
