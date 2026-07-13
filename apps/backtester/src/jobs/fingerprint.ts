// Request fingerprint for idempotency. sha256 over ONLY the run-affecting fields — orchestration /
// callback / timeout fields are excluded (a replay that changes only those is the same run). Mirrors
// trading-platform `mcp-gateway/handlers/submit-run.ts::fingerprintOf`.

import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import type { RunSubmitRequest } from '@trading-backtester/sdk/contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { sha256Hex } from '../determinism/hash';
import { bundleHash } from '../sandbox/bundle';

// ALL run-affecting fields. `bundleHashValue` = content hash of the submitted bundle (null for trusted
// runs), passed in so an incoming submit (bundle bytes present) and a stored job (bundle already a hash)
// produce the SAME object for the same request.
function normalize(req: RunSubmitRequest, bundleHashValue: ContentHash | null) {
  return {
    datasetRef: req.datasetRef,
    moduleRef: req.moduleRef,
    moduleBundle: bundleHashValue,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
    params: req.params ?? null,
    seed: req.seed,
    mode: req.mode,
    metrics: req.metrics ?? [],
    // run-affecting fields previously (incorrectly) omitted:
    engine: req.engine ?? null,
    overlayRefs: req.overlayRefs ?? [],
    riskProfileRef: req.riskProfileRef ?? null,
    executionProfileRef: req.executionProfileRef ?? null,
    robustnessChecks: req.robustnessChecks ?? [],
    // curatedBaselineRef is run-affecting for strategy-evidence runs (curated twin + signed evidenceRef).
    // Included CONDITIONALLY so requests without it keep byte-identical fingerprints (no dedup-cache
    // churn; curated runs bypass the cache anyway) while a replay that changes it is no longer identical.
    ...(req.curatedBaselineRef !== undefined ? { curatedBaselineRef: req.curatedBaselineRef } : {}),
  };
}

/** Fingerprint of an INCOMING submit request. Bundle source is folded to a single ContentHash before
 *  normalization: bundle bytes present → hashed inline; otherwise `bundleRef` (already a hash) is used
 *  directly — so an inline submit and a by-ref submit of the SAME bundle produce the SAME fingerprint. */
export function requestFingerprint(req: RunSubmitRequest): string {
  const bundleHashValue = req.moduleBundle ? bundleHash(req.moduleBundle) : (req.bundleRef ?? null);
  return sha256Hex(canonicalJson(normalize(req, bundleHashValue)));
}

/**
 * Fingerprint of an ALREADY-STORED job, recomputed with the CURRENT algorithm from its persisted
 * `request` + content-addressed bundle hash. Equals `requestFingerprint(originalBody)` exactly because
 * `bundleStore.put` returns the same `bundleHash` the inline path hashes. The idempotency conflict guard
 * uses this so a `resumeToken` replay is identical iff EVERY run-affecting field matches — independent of
 * which algorithm version wrote the stored row.
 */
export function storedRequestFingerprint(req: RunSubmitRequest, bundleHashValue: ContentHash | null): string {
  return sha256Hex(canonicalJson(normalize(req, bundleHashValue)));
}
