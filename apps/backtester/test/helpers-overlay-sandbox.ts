// Slice-6b-A — shared builder for the LIFTED sandbox overlay pipeline (reused by the session
// smoke test AND the Task-10 byte-parity gate).
//
// Wires the real sandbox-routing seam end-to-end: an accepted overlay bundle (materialized to disk)
// becomes an inert-proxy module in `createModuleRegistry`, and `createExecutorRouter` routes its
// `apply` hook to a `SandboxModuleExecutor` running the OVERLAY harness inside the pinned container.
// Everything is keyed off `loadConfig().overlaySandbox` so the policy (pinned image digest) and
// harness dir are the production values — no test-only overrides.
//
// TOPOLOGY (mirrors the platform reference verify_019_overlay_variant.mjs): the STRATEGY is trusted
// (in-process), only the OVERLAY is a sandboxed bundle. This is the canonical lifted overlay-sandbox
// shape — the platform never sandboxes a strategy AND runs a variant in one router (a sandboxed
// strategy run is always baseline-only; see verify_020_equivalence.mjs). Sandboxing the strategy here
// too would re-`open()` the symbol-keyed session for the variant target and collide on the container
// name (the cached baseline container is still alive until `closeAll`), which the seam does not guard.

import { loadConfig } from '../src/config.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import { DEFAULT_EXEC, DEFAULT_RISK } from '../src/engine/profiles.js';
import { materializeBundle, type MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import {
  createExecutorRouter,
  createModuleRegistry,
  type ExecutorRouter,
  type ModuleRegistry019,
} from '../src/engine/sandbox/routing.js';
import { createSandboxPolicyRegistry } from '../src/engine/sandbox-policy.js';

/**
 * Materialize an inline `ModuleBundle` to disk (world-readable for sandbox `nobody`).
 */
export async function materializeReadableBundle(
  inline: InlineModuleBundle,
): Promise<MaterializedBundle> {
  return materializeBundle(inline);
}

/** Materialized bundle dir(s) for the sandbox overlay run. */
export interface SandboxOverlayDirs {
  /** `early_exit_short_after_pump` overlay bundle dir (materialized + world-readable). */
  readonly eeDir: string;
}

/** Materialized bundle dir for the sandbox baseline-only (sandboxed STRATEGY) run. */
export interface SandboxStrategyDirs {
  /** `short_after_pump` strategy bundle dir (materialized + world-readable). */
  readonly spDir: string;
}

/** Registry + sandbox-aware router built over a materialized bundle. */
export interface SandboxOverlayDeps {
  readonly registry: ModuleRegistry019;
  readonly router: ExecutorRouter;
}

/**
 * Build the registry + sandbox executor router for an overlay run THROUGH the container.
 *
 * - `createModuleRegistry` takes the trusted `short_after_pump` strategy (in-process) and the
 *   materialized overlay bundle as an untrusted `overlayBundle` (→ inert proxy, provenance `bundle`),
 *   plus the default risk/execution profiles and the overlay sandbox policy from config (pinned image
 *   digest).
 * - `createExecutorRouter` gets a policy registry over that same policy and `sandboxDeps.harnessDir`
 *   pointing at the built overlay harness — so the bundle-provenance overlay `apply` routes to a real
 *   `SandboxModuleExecutor` (container) while the trusted strategy stays in-process.
 *
 * The caller owns `router.closeAll()` (session teardown / `docker rm -f`).
 */
export function buildSandboxOverlayDeps(dirs: SandboxOverlayDirs): SandboxOverlayDeps {
  const config = loadConfig();
  const policy = config.overlaySandbox.policy;

  const registry = createModuleRegistry({
    strategies: [shortAfterPump],
    overlayBundles: [loadBundle(dirs.eeDir)],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [DEFAULT_EXEC],
    sandboxPolicies: [policy],
  });

  const router = createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: { harnessDir: config.overlaySandbox.harnessDir },
  });

  return { registry, router };
}

/**
 * Build the registry + sandbox executor router for a BASELINE-ONLY run with a SANDBOXED STRATEGY.
 *
 * TOPOLOGY (mirrors the platform reference verify_020_equivalence.mjs): the `short_after_pump`
 * STRATEGY is an untrusted `strategyBundle` (→ inert proxy, provenance `bundle`) and there are NO
 * overlays. A baseline-only request resolves to a SINGLE target, so the symbol-keyed session is
 * `open()`ed exactly once — no container-name collision (contrast the unsupported sandboxed-strategy
 * + variant shape, which re-opens the session for the variant target while the baseline container is
 * still alive). The strategy's `onBarClose` hook routes to a real `SandboxModuleExecutor` (container).
 *
 * Same router wiring as `buildSandboxOverlayDeps` (one shared policy, same harness dir). The caller
 * owns `router.closeAll()` (session teardown / `docker rm -f`).
 */
export function buildSandboxStrategyBaselineDeps(dirs: SandboxStrategyDirs): SandboxOverlayDeps {
  const config = loadConfig();
  const policy = config.overlaySandbox.policy;

  const registry = createModuleRegistry({
    strategyBundles: [loadBundle(dirs.spDir)],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [DEFAULT_EXEC],
    sandboxPolicies: [policy],
  });

  const router = createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: { harnessDir: config.overlaySandbox.harnessDir },
  });

  return { registry, router };
}
