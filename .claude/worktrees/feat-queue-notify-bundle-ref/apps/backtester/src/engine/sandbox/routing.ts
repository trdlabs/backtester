// 019 — ExecutorRouter + inert-proxy модули + createModuleRegistry (US2; data-model §8.1/§8.3,
// research R12; FR-008/010/030).
//
// Router выбирает исполнитель ПО ПРОВЕНАНСУ: trusted → InProcessTrustedModuleExecutor; bundle →
// SandboxModuleExecutor (контейнер). Для bundle-модулей `module` — INERT-PROXY: хук-свойства
// присутствуют по manifest.hooks, но тела — guard'ы (throw при прямом in-process вызове ⇒ FR-010).
// `createModuleRegistry` расширяет 018 trusted-registry провенансом + bundle handle + sandbox-policies.

import type { ExecutionProfile, RiskProfile } from '@trading/research-contracts/research';
import type {
  HypothesisOverlayModule,
  ModuleManifest,
  StrategyModule,
} from '@trading/research-contracts/research';
import type { StrategyContext } from '@trading/research-contracts/research';
import type { Ref } from '@trading/research-contracts/research';
import type { ResolvedOverlay, ResolvedStrategy } from '../artifacts.js';
import {
  type ModuleExecutor,
  type ExecutorRouter as BaseExecutorRouter,
  InProcessTrustedModuleExecutor,
} from '../module-executor.js';
import type { TrustedModuleRegistry } from '../registry.js';
import type { ModuleBundle } from './bundle.js';
import {
  DEFAULT_SANDBOX,
  type SandboxPolicy,
  type SandboxPolicyRegistry,
  createSandboxPolicyRegistry,
} from '../sandbox-policy.js';
import { SandboxModuleExecutor, type SandboxExecutorDeps } from './sandbox-executor.js';
import type { SandboxErrorArtifact } from './errors.js';

/** Происхождение резолвнутого модуля — метаданные routing'а (НЕ привилегия). */
export type Provenance = 'trusted' | 'bundle';

/** 019-расширение резолвнутой стратегии: провенанс + (для bundle) handle. */
export interface ResolvedStrategy019 extends ResolvedStrategy {
  readonly provenance: Provenance;
  readonly bundle?: ModuleBundle;
}

/** 019-расширение резолвнутого overlay. */
export interface ResolvedOverlay019 extends ResolvedOverlay {
  readonly provenance: Provenance;
  readonly bundle?: ModuleBundle;
}

const DEFAULT_SANDBOX_REF: Ref = { id: DEFAULT_SANDBOX.id, version: DEFAULT_SANDBOX.version };

function guardHook(hook: string): never {
  throw new Error(
    `FR-010: bundle module hook "${hook}" must not be invoked in-process; route via SandboxModuleExecutor`,
  );
}

/** Inert-proxy strategy-модуля: хуки по manifest.hooks, тела — guard'ы (throw in-process). */
export function createInertStrategyModule(manifest: ModuleManifest): StrategyModule {
  const m: {
    manifest: ModuleManifest;
    onBarClose: (ctx: StrategyContext) => never;
    init?: (ctx: StrategyContext) => never;
    onPositionBar?: (ctx: StrategyContext) => never;
    onPendingIntentBar?: (ctx: StrategyContext) => never;
    dispose?: (ctx: StrategyContext) => never;
  } = {
    manifest,
    onBarClose: () => guardHook('onBarClose'),
  };
  if (manifest.hooks.includes('init')) m.init = () => guardHook('init');
  if (manifest.hooks.includes('onPositionBar')) m.onPositionBar = () => guardHook('onPositionBar');
  if (manifest.hooks.includes('onPendingIntentBar')) m.onPendingIntentBar = () => guardHook('onPendingIntentBar');
  if (manifest.hooks.includes('dispose')) m.dispose = () => guardHook('dispose');
  return m;
}

/** Inert-proxy overlay-модуля: `apply` — guard. */
export function createInertOverlayModule(manifest: ModuleManifest): HypothesisOverlayModule {
  return { manifest, apply: () => guardHook('apply') };
}

/** Вход построителя 019 module-registry (расширяет 018 trusted-registry). */
export interface ModuleRegistryInput {
  // trusted: инстанс модуля; опц. `moduleFactory` (аддитивно) включает per-symbol инстанцирование
  // в runner'е (изоляция module-state между символами — паритет с sandbox-сессиями).
  readonly strategies?: readonly (StrategyModule & {
    readonly moduleFactory?: (params: unknown) => StrategyModule;
  })[];
  readonly overlays?: readonly HypothesisOverlayModule[]; // trusted
  readonly strategyBundles?: readonly ModuleBundle[]; // untrusted (accepted)
  readonly overlayBundles?: readonly ModuleBundle[];
  readonly riskProfiles?: readonly RiskProfile[];
  readonly executionProfiles?: readonly ExecutionProfile[];
  readonly sandboxPolicies?: readonly SandboxPolicy[];
}

/** 019 module-registry: TrustedModuleRegistry с провенанс-резолвом + SandboxPolicyRegistry. */
export interface ModuleRegistry019 extends TrustedModuleRegistry, SandboxPolicyRegistry {
  resolveStrategy(ref: Ref): ResolvedStrategy019 | undefined;
  resolveOverlay(ref: Ref): ResolvedOverlay019 | undefined;
  resolveSandboxPolicy(ref: Ref): SandboxPolicy | undefined;
}

function key(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Построить 019 module-registry из trusted-модулей + accepted bundles + профилей + sandbox-policies. */
export function createModuleRegistry(input: ModuleRegistryInput): ModuleRegistry019 {
  const strategies = new Map<string, ResolvedStrategy019>();
  for (const m of input.strategies ?? []) {
    strategies.set(key(m.manifest.id, m.manifest.version), {
      module: m,
      manifest: m.manifest,
      provenance: 'trusted',
      ...(m.moduleFactory !== undefined ? { moduleFactory: m.moduleFactory } : {}),
    });
  }
  for (const b of input.strategyBundles ?? []) {
    strategies.set(key(b.manifest.id, b.manifest.version), {
      module: createInertStrategyModule(b.manifest),
      manifest: b.manifest,
      provenance: 'bundle',
      bundle: b,
    });
  }

  const overlays = new Map<string, ResolvedOverlay019>();
  for (const m of input.overlays ?? []) {
    overlays.set(key(m.manifest.id, m.manifest.version), { module: m, manifest: m.manifest, provenance: 'trusted' });
  }
  for (const b of input.overlayBundles ?? []) {
    overlays.set(key(b.manifest.id, b.manifest.version), {
      module: createInertOverlayModule(b.manifest),
      manifest: b.manifest,
      provenance: 'bundle',
      bundle: b,
    });
  }

  const riskProfiles = new Map<string, RiskProfile>();
  for (const p of input.riskProfiles ?? []) riskProfiles.set(key(p.id, p.version), p);
  const executionProfiles = new Map<string, ExecutionProfile>();
  for (const p of input.executionProfiles ?? []) executionProfiles.set(key(p.id, p.version), p);

  const policyRegistry = createSandboxPolicyRegistry(input.sandboxPolicies ?? [DEFAULT_SANDBOX]);

  return {
    resolveStrategy: (ref) => strategies.get(key(ref.id, ref.version)),
    resolveOverlay: (ref) => overlays.get(key(ref.id, ref.version)),
    resolveRiskProfile: (ref) => riskProfiles.get(key(ref.id, ref.version)),
    resolveExecutionProfile: (ref) => executionProfiles.get(key(ref.id, ref.version)),
    resolve: (ref) => policyRegistry.resolve(ref),
    resolveSandboxPolicy: (ref) => policyRegistry.resolve(ref),
  };
}

/** Зависимости router'а (всё опционально; дефолты — trusted + default_sandbox). */
export interface ExecutorRouterDeps {
  readonly sandboxPolicies?: SandboxPolicyRegistry;
  readonly sandboxPolicyRef?: Ref;
  readonly trustedExecutor?: ModuleExecutor;
  readonly sandboxDeps?: SandboxExecutorDeps;
}

/** 019 sandbox-aware router (расширяет 018 seam агрегацией ошибок для verify/диагностики). */
export interface ExecutorRouter extends BaseExecutorRouter {
  /** Агрегированные ошибки всех sandbox-исполнителей. */
  errors(): readonly SandboxErrorArtifact[];
}

function provenanceOf(r: ResolvedStrategy | ResolvedOverlay): { provenance: Provenance; bundle?: ModuleBundle } {
  const x = r as Partial<ResolvedStrategy019>;
  return { provenance: x.provenance ?? 'trusted', bundle: x.bundle };
}

/** Создать router. Sandbox-исполнители кэшируются по `bundleHash` (сессии живут между вызовами). */
export function createExecutorRouter(deps: ExecutorRouterDeps = {}): ExecutorRouter {
  const trusted = deps.trustedExecutor ?? new InProcessTrustedModuleExecutor();
  const policies = deps.sandboxPolicies ?? createSandboxPolicyRegistry([DEFAULT_SANDBOX]);
  const policyRef = deps.sandboxPolicyRef ?? DEFAULT_SANDBOX_REF;
  const sandboxExecutors = new Map<string, SandboxModuleExecutor>();
  // Накопитель ошибок, ПЕРЕЖИВАЮЩИЙ closeAll() (runner вызывает closeAll в finally → иначе
  // post-run errors() терял бы диагностику; см. verify_019_no_host_import).
  const collected: SandboxErrorArtifact[] = [];

  function sandboxFor(bundle: ModuleBundle): ModuleExecutor {
    const existing = sandboxExecutors.get(bundle.descriptor.bundleHash);
    if (existing !== undefined) return existing;
    const policy = policies.resolve(policyRef) ?? DEFAULT_SANDBOX;
    const exec = new SandboxModuleExecutor(bundle, policy, deps.sandboxDeps);
    sandboxExecutors.set(bundle.descriptor.bundleHash, exec);
    return exec;
  }

  function route(resolved: ResolvedStrategy | ResolvedOverlay): ModuleExecutor {
    const { provenance, bundle } = provenanceOf(resolved);
    if (provenance === 'bundle' && bundle !== undefined) return sandboxFor(bundle);
    return trusted;
  }

  return {
    forStrategy: (resolved) => route(resolved),
    forOverlay: (resolved) => route(resolved),
    closeAll: () => {
      for (const e of sandboxExecutors.values()) {
        collected.push(...e.errors); // сохранить до очистки
        e.close();
      }
      sandboxExecutors.clear();
      trusted.close?.();
    },
    errors: () => {
      const live: SandboxErrorArtifact[] = [];
      for (const e of sandboxExecutors.values()) live.push(...e.errors);
      return [...collected, ...live];
    },
  };
}
