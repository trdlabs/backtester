// 019 — публичный вход sandbox-шлюза исполнения agent-generated 017-модулей.
//
// Скелет (Phase 2 Foundational): пока реэкспортирует только таксономию ошибок. Расширяется по
// историям: US1 (loadBundle/validateBundle), US2 (SandboxModuleExecutor/ExecutorRouter/
// createModuleRegistry/DEFAULT_SANDBOX/SANDBOX_POLICIES) и т.д.
export * from './errors.js';
export { redact } from './redaction.js';

// US1 — acceptance-gate (host-only, без Docker).
export type { ModuleBundle, BundleDescriptor, BundleFileEntry } from './bundle.js';
export { loadBundle } from './bundle.js';
export { computeBundleHash, sha256Hex } from './bundle-hash.js';
export type { ComputedBundleHash } from './bundle-hash.js';
export { validateBundle } from './acceptance-gate.js';

// US2 — sandbox-исполнение (Docker).
export {
  DEFAULT_SANDBOX,
  TINY_MEM_SANDBOX,
  SANDBOX_POLICIES,
  SANDBOX_IMAGE,
  createSandboxPolicyRegistry,
} from '../sandbox-policy.js';
export type {
  SandboxPolicy,
  SandboxPolicyRegistry,
  ResourceLimits,
  IsolationParams,
} from '../sandbox-policy.js';
export { SandboxModuleExecutor, defaultHarnessDir } from './sandbox-executor.js';
export type { SandboxExecutorDeps } from './sandbox-executor.js';
export { DecisionRevalidator } from './decision-revalidator.js';
export { serializeContext } from './context-serializer.js';
export type { ContextSnapshot } from './context-serializer.js';
export { DockerDriver, buildDockerRunArgs, sessionContainerName } from './docker-driver.js';
export {
  createModuleRegistry,
  createExecutorRouter,
  createInertStrategyModule,
  createInertOverlayModule,
} from './routing.js';
export type {
  ModuleRegistry019,
  ModuleRegistryInput,
  ExecutorRouter,
  ExecutorRouterDeps,
  ResolvedStrategy019,
  ResolvedOverlay019,
  Provenance,
} from './routing.js';
