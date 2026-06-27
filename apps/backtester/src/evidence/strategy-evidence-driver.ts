// Task 1 (R1) — end-to-end evidence driver: single-source bundle → gate → twin runs → sign.
//
// Orchestrates the full chain from ONE inline bundle source:
//   materialize → loadBundle (gated) → buildOverlayDataset → curated run → candidate run →
//   produceStrategyEvidence → signed ProduceStrategyResult.
//
// SINGLE CALL-SITE: the gated `bundle` (materialized from `input.inlineBundle`) and the signed
// `bundleBytes` arrive on ONE call, so byte↔bundle correspondence is established at a single point
// rather than threaded across the run pipeline. They are still independent input fields — the
// CALLER owns the guarantee that `bundleBytes` are the raw bytes of `inlineBundle` (for a Variant-2
// flat ESM that is Buffer.from(inlineBundle.files[inlineBundle.entry], 'utf8')). `bundleHash` =
// sha256BundleRef(input.bundleBytes) inside produceStrategyEvidence (lab-pinned raw bytes; NOT
// recomputed from bundleDir — cross-boundary contract: lab-pinned raw bytes, not a
// post-materialization re-hash of disk layout). Byte-equality between bundleBytes and the
// inlineBundle entry file is asserted at the top of the driver (H2 consistency guard, enforced).
//
// SANDBOX-ROUTER WIRING: inlined verbatim from
// test/helpers-overlay-sandbox.ts::buildSandboxStrategyBaselineDeps (that helper is test-only;
// this driver lives in src/ and cannot import it). Same policy/harnessDir source: loadConfig().
// Production omits containerSuffix — `backtesterRunId` makes each run session-unique (per
// SandboxExecutorDeps comment: "Прод НЕ задаёт").
//
// REGISTRY: buildInlineOverlayRegistry([], [bundle]) is the single-source equivalent of the
// helper's createModuleRegistry({ strategyBundles:[bundle], … }) + TRUSTED_REGISTRY_DEFINITION
// profiles — same contract via the shared definition (no drift between driver and helper).

import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { materializeBundle } from '../engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../engine/sandbox/bundle.js';
import { buildOverlayDataset, type OverlayDatasetSelector } from '../engine/data-adapter.js';
import { runOverlayBacktest } from '../engine/run-overlay.js';
import { runStrategyBacktest } from '../engine/run-strategy.js';
import { buildTrustedRegistry, buildInlineOverlayRegistry } from '../engine/trusted-registry.js';
import { createExecutorRouter } from '../engine/sandbox/routing.js';
import { createSandboxPolicyRegistry } from '../engine/sandbox-policy.js';
import { loadConfig } from '../config.js';
import { produceStrategyEvidence, type ProduceStrategyResult } from './produce-strategy-evidence.js';
import type { EvidenceScope } from './body.js';
import type { SigningKey } from './signing.js';
import type { BacktesterDataPort } from '../data/reader.js';

export interface StrategyEvidenceDriverInput {
  /** Inline wire-form bundle: single source of truth for both the gated bundle and bundleBytes. */
  readonly inlineBundle: InlineModuleBundle;
  /**
   * Exact raw ESM bytes the lab pinned — sha256BundleRef hashes these into bundleHash.
   * Must be Buffer.from(inlineBundle.files[inlineBundle.entry], 'utf8') or equivalent raw bytes.
   * NOT recomputed from bundleDir after materialization — cross-boundary contract with the lab.
   */
  readonly bundleBytes: Uint8Array;
  /** Dataset selector forwarded to buildOverlayDataset. */
  readonly dataset: OverlayDatasetSelector;
  /** Curated and candidate run request; moduleRef must reference the bundle manifest. */
  readonly baselineRequest: BacktestRunRequest;
  readonly scope: EvidenceScope;
  readonly key: SigningKey;
  readonly backtesterRunId: string;
  /** Data port (FixtureDataPort in tests, networked port in production). */
  readonly dataPort: BacktesterDataPort;
}

/**
 * End-to-end evidence driver: materialize one bundle, run both curated (trusted, in-process) and
 * candidate (strategy-route sandbox) backtests, then produce a signed ProduceStrategyResult.
 *
 * H2 guard (at entry): asserts `bundleBytes` byte-equals `inlineBundle.files[entry]` encoded as
 * UTF-8 — throws `'bundleBytes do not match inlineBundle entry file'` before any Docker work.
 *
 * H1 guard (after candidate run, before compareBacktestRuns): captures `router.errors()` and
 * throws `'sandbox execution failed: …'` with JSON detail if the sandbox crashed, so a container
 * failure surfaces as a clear error rather than an opaque equivalence divergence.
 *
 * bundleHash stays lab-pinned (sha256 of bundleBytes; NOT re-hashed from bundleDir).
 * `finally`: cleanup materialized dir + close sandbox router (deterministic docker rm -f).
 */
export async function produceStrategyEvidenceForBundle(
  input: StrategyEvidenceDriverInput,
): Promise<ProduceStrategyResult> {
  // ── (H2) bundleBytes ↔ inlineBundle entry consistency guard ────────────────────────────────
  // For Variant-2 flat self-contained ESM the raw bytes ARE the entry-file content encoded UTF-8.
  // Throws before any Docker work — safe to call in non-Docker test environments.
  const entryStr = input.inlineBundle.files[input.inlineBundle.entry];
  if (entryStr == null) {
    throw new Error(
      `inlineBundle.files has no entry "${input.inlineBundle.entry}" — malformed bundle`,
    );
  }
  if (!Buffer.from(input.bundleBytes).equals(Buffer.from(entryStr, 'utf8'))) {
    throw new Error(
      'bundleBytes do not match inlineBundle entry file — caller must pass the raw bytes of the bundle',
    );
  }

  // ── (1) materialize inline bundle → temp dir (world-readable for sandbox 'nobody') ──────────
  const sp = await materializeBundle(input.inlineBundle);

  // ── (2) build sandbox executor router ────────────────────────────────────────────────────────
  // Inlined from buildSandboxStrategyBaselineDeps (test/helpers-overlay-sandbox.ts).
  // loadConfig().overlaySandbox supplies the pinned image policy and harness dir — production values.
  const config = loadConfig();
  const policy = config.overlaySandbox.policy;
  const router = createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: { harnessDir: config.overlaySandbox.harnessDir },
  });

  try {
    // ── (3) load the materialized bundle (acceptance-gate reads this inside produceStrategyEvidence)
    const bundle = loadBundle(sp.bundleDir);

    // ── (4) build market tape (shared between curated and candidate runs) ───────────────────────
    const marketTape = await buildOverlayDataset(input.dataPort, input.dataset);

    // ── (5) curated run — trusted, fully in-process (6a overlay path) ──────────────────────────
    // Mirrors strategy-route.integration.test.ts: buildTrustedRegistry() + no router.
    const curated = await runOverlayBacktest(input.baselineRequest, {
      registry: buildTrustedRegistry(),
      marketTape,
    });

    // ── (6) candidate run — kind:'strategy' bundle via strategy route (sandbox) ─────────────────
    // buildInlineOverlayRegistry([], [bundle]) = TRUSTED_REGISTRY_DEFINITION profiles/policies +
    // strategyBundles:[bundle]; provenance='bundle' → onBarClose routes to SandboxModuleExecutor.
    // engine:'strategy' is stripped by runStrategyBacktest before the hashed RunOutcome.
    const candidate = await runStrategyBacktest(
      { ...input.baselineRequest, engine: 'strategy' },
      { registry: buildInlineOverlayRegistry([], [bundle]), marketTape, router },
    );

    // ── (H1) surface sandbox errors before compareBacktestRuns ───────────────────────────────────
    // Captured BEFORE finally's router.closeAll() so live executor errors are visible.
    // A sandbox crash would otherwise silently produce 0 trades → opaque equivalence divergence.
    const sandboxErrors = router.errors();
    if (sandboxErrors.length > 0) {
      throw new Error('sandbox execution failed: ' + JSON.stringify(sandboxErrors));
    }

    // ── (7) produce signed evidence ──────────────────────────────────────────────────────────────
    // bundleBytes = input.bundleBytes (lab-pinned); NOT recomputed from sp.bundleDir.
    return produceStrategyEvidence({
      bundle,
      bundleBytes: input.bundleBytes,
      curated,
      candidate,
      scope: input.scope,
      key: input.key,
      backtesterRunId: input.backtesterRunId,
    });
  } finally {
    // Deterministic teardown: docker rm -f session container + remove temp dir.
    router.closeAll();
    await sp.cleanup();
  }
}
