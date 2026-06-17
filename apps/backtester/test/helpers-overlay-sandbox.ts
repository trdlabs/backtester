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

import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import { DEFAULT_EXEC, DEFAULT_RISK } from '../src/engine/profiles.js';
import {
  materializeBundle,
  type MaterializedBundle,
} from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import {
  createExecutorRouter,
  createModuleRegistry,
  type ExecutorRouter,
  type ModuleRegistry019,
} from '../src/engine/sandbox/routing.js';
import { createSandboxPolicyRegistry } from '../src/engine/sandbox-policy.js';

/** Recursively widen the materialized tree to world `r`/`X` (dirs traversable, files readable). */
async function makeWorldReadable(path: string): Promise<void> {
  const info = await stat(path);
  // Dirs need +x (traverse) AND +r; files need +r. Mirror `chmod -R a+rX`.
  await chmod(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await makeWorldReadable(join(path, entry));
  }
}

/**
 * Materialize an inline `ModuleBundle` to disk AND widen its perms so the in-container `nobody`
 * (`--user 65534:65534`) can traverse + read it.
 *
 * `materializeBundle` creates the temp dir via `mkdtemp` (mode `0700` — owner-only). The sandbox
 * harness runs as an unprivileged user against a `:ro` mount, so a `0700` bundle dir makes the ESM
 * `import('/sandbox/bundle/<entryPoint>')` fail with `ERR_MODULE_NOT_FOUND` (surfaced as
 * `sandbox_forbidden_import`) and every hook fail-closes to idle. Widening perms is a host-side
 * test concern (the production submit/worker path stages bundles under a world-readable root).
 */
export async function materializeReadableBundle(
  inline: InlineModuleBundle,
): Promise<MaterializedBundle> {
  const mat = await materializeBundle(inline);
  await makeWorldReadable(mat.bundleDir);
  return mat;
}

/** Materialized bundle dir(s) for the sandbox overlay run. */
export interface SandboxOverlayDirs {
  /** `early_exit_short_after_pump` overlay bundle dir (materialized + world-readable). */
  readonly eeDir: string;
}

/** Registry + sandbox-aware router built over the materialized overlay bundle. */
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
