// Task 7 — abort-before-sign evidence flow for the strategy-route twin (short_after_pump).
//
// Order (abort-before-sign):
//   1. acceptance-gate  validateBundle  → rejected   ⇒ throw (no evidence)
//   2. twin-equivalence compareBacktestRuns → !equivalent ⇒ throw (bar + diff)
//   3. metrics → verdict !== 'passed'             ⇒ throw (NEVER sign except from real metrics)
//   4. sign: sha256BundleRef → buildEvidenceBody → signEvidence → serializeArtifact/artifactRef

import { platformContractContext } from '@trading/research-contracts/research';
import type { RunOutcome } from '../engine/artifacts.js';
import { compareBacktestRuns } from '../engine/equivalence.js';
import type { ModuleBundle } from '../engine/sandbox/bundle.js';
import { validateBundle } from '../engine/sandbox/acceptance-gate.js';
import { computeMetrics } from '../engine/metrics.js';
import { decideVerdict } from './verdict.js';
import { buildEvidenceBody, type EvidenceScope, type SignedBacktestEvidence } from './body.js';
import { signEvidence, type SigningKey } from './signing.js';
import { serializeArtifact, artifactRef, sha256BundleRef } from './artifact.js';

export interface StrategyEvidenceInput {
  /** Materialized (bundleDir + descriptor) host-side bundle — consumed by the acceptance-gate. */
  readonly bundle: ModuleBundle;
  /** Raw ESM bytes of the bundle payload — hashed into bundleHash via sha256BundleRef. */
  readonly bundleBytes: Uint8Array;
  /** Trusted curated baseline run (platform paper-engine replay or equivalent). */
  readonly curated: RunOutcome;
  /** Candidate strategy-route (sandbox) run that must be byte-equivalent to curated. */
  readonly candidate: RunOutcome;
  readonly scope: EvidenceScope;
  readonly key: SigningKey;
  readonly backtesterRunId: string;
}

export interface ProduceStrategyResult {
  readonly artifact: SignedBacktestEvidence;
  readonly artifactRef: string;
  /** 'sha256:<hex64>' of bundleBytes. */
  readonly bundleHash: string;
  readonly keyId: string;
  /** Always 'passed': the function throws on any non-'passed' verdict before returning. */
  readonly verdict: 'passed';
}

/**
 * Full lifecycle proof: abort-before-sign gate → twin-equivalence → verdict → sign.
 *
 * Signs ONLY when all three pre-conditions pass:
 *   - acceptance-gate accepted the bundle (019/017 integrity + contract version + manifest)
 *   - curated and candidate are byte-equivalent (same result_hash + no per-trade field divergence)
 *   - real computeMetrics → decideVerdict yields 'passed'
 *
 * Every failure throws before the signing step — no artifact is emitted on any failure path.
 */
export function produceStrategyEvidence(input: StrategyEvidenceInput): ProduceStrategyResult {
  // ── (1) acceptance-gate ──────────────────────────────────────────────────────
  // validateBundle checks: structure, contractVersion, bundleHash integrity, 017-manifest.
  // platformContractContext supplies the authoritative supported-versions + strategy-ref catalog.
  const ctx = platformContractContext([input.bundle.manifest.id]);
  const gate = validateBundle(input.bundle, ctx);
  if (gate.status === 'rejected') {
    throw new Error(
      `bundle validation rejected — return to lab; no evidence emitted: ${JSON.stringify(gate.issues)}`,
    );
  }

  // ── (2) twin-equivalence ─────────────────────────────────────────────────────
  // Checks Layer 1 (result_hash via contentRef) and Layer 2 (per-trade field diff).
  const eq = compareBacktestRuns(input.curated, input.candidate);
  if (!eq.equivalent) {
    const d = eq.firstDivergence;
    throw new Error(
      d
        ? `equivalence failed at trade #${d.index} field ${d.field}: expected ${String(d.expected)}, got ${String(d.actual)}`
        : `equivalence divergence (result_hash mismatch; curated ${eq.curatedTradeCount} trades, candidate ${eq.candidateTradeCount})`,
    );
  }

  // ── (3) metrics → verdict ────────────────────────────────────────────────────
  // INVARIANT: NEVER sign 'passed' except from real computeMetrics→decideVerdict on the candidate run.
  if (input.candidate.status !== 'completed') throw new Error('candidate run not completed');
  const metrics = computeMetrics(
    ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'],
    input.candidate.baseline.evidence.equityCurve,
    input.candidate.baseline.trades,
  );
  const verdict = decideVerdict(metrics);
  if (verdict !== 'passed') throw new Error(`verdict ${verdict} — not signing`);

  // ── (4) sign ─────────────────────────────────────────────────────────────────
  const bundleHash = sha256BundleRef(input.bundleBytes);
  const body = buildEvidenceBody({
    backtesterRunId: input.backtesterRunId,
    bundleHash,
    verdict,
    scope: input.scope,
    keyId: input.key.keyId,
  });
  const artifact = signEvidence(body, input.key.privateKey) as SignedBacktestEvidence;
  return {
    artifact,
    artifactRef: artifactRef(serializeArtifact(artifact)),
    bundleHash,
    keyId: input.key.keyId,
    verdict,
  };
}
