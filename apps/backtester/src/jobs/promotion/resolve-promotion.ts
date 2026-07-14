// E4b — worker orchestration for the held-out promotion gate. Canonical order:
// signing → curated → integrity(gate→twin) → resolve(epoch+coverage→holdout) → window → verdict →
// record(ledger) → metrics_failed / sign+persist. enabled+promotion ALWAYS returns a PromotionResult.
import { canonicalJson } from '../../determinism/canonical-json.js';
import { sha256Hex, contentRef } from '../../determinism/hash.js';
import { evaluatePromotionIntegrity, evaluatePromotionWindow } from '../../evidence/promotion-gate.js';
import { buildEvidenceBodyV2 } from '../../evidence/body-v2.js';
import { signEvidence, type SigningKey } from '../../evidence/signing.js';
import { sha256BundleRef } from '../../evidence/artifact.js';
import { DEFAULT_THRESHOLDS } from '../../evidence/verdict.js';
import { computeHoldoutWindow } from '../../engine/holdout.js';
import { validateBundle } from '../../engine/sandbox/acceptance-gate.js';
import { platformContractContext } from '@trading/research-contracts/research';
import { computePromotionFamilyKey, computeQualificationEpochKey, computeAttemptIdentity } from './identity.js';
import type { PromotionAttemptLedger } from './attempt-ledger.js';
import type { QualificationEpochResolver } from './epoch-resolver.js';
import type { CompletedOutcome } from '../../engine/window-eval.js';
import type { JobRow } from '../job-store.js';
import type { ModuleBundle } from '../../engine/sandbox/bundle.js';
import type { PromotionResult, PromotionFailureReason, RunPeriod } from '@trading-backtester/sdk/contracts';
import type { ArtifactReference, ContentHash } from '@trading-backtester/sdk/artifacts';

export function buildPromotionPolicy(cfg: { holdoutFraction: number }) {
  const thresholds = DEFAULT_THRESHOLDS;
  const metrics = ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'] as const;
  const minWarmupBars = 1, minTrades = 1, fraction = cfg.holdoutFraction;
  // metrics is in the preimage so a future configurable metric set auto-bumps the epoch regime
  // (two materially different gate policies must never collide on one policyVersion).
  const policyVersion = sha256Hex(canonicalJson({ fraction, thresholds, metrics: [...metrics], minWarmupBars, minTrades }));
  return { policyVersion, thresholds, metrics: [...metrics], minWarmupBars, minTrades, fraction };
}
export type PromotionPolicy = ReturnType<typeof buildPromotionPolicy>;

export interface PromotionDeps {
  readonly enabled: boolean;
  readonly ledger: PromotionAttemptLedger;
  readonly epochResolver: QualificationEpochResolver;
  readonly policy: PromotionPolicy;
}
export interface PromotionCtx {
  readonly candidate: CompletedOutcome;
  readonly curated: CompletedOutcome | null;
  readonly signingKey?: SigningKey;
  readonly bundle: ModuleBundle;
  readonly bundleBytes: Uint8Array;
  readonly datasetFingerprint: string;
  readonly coverage: RunPeriod | null;
  readonly runId: string;
  readonly clock: () => number;
  readonly writeArtifact: (artifact: { body: unknown; signature: string }) => Promise<string>;
}

const periodToMs = (p: RunPeriod) => ({ fromMs: Date.parse(p.from), toMs: Date.parse(p.to) });
function bundleRejected(bundle: ModuleBundle): boolean {
  return validateBundle(bundle, platformContractContext([bundle.manifest.id])).status === 'rejected';
}

export async function resolvePromotionGate(
  deps: PromotionDeps, claimed: JobRow, ctx: PromotionCtx,
): Promise<{ promotion: PromotionResult; evidenceRef?: ArtifactReference } | undefined> {
  if (!deps.enabled || claimed.request.mode !== 'promotion') return undefined;
  const nq = (reason: PromotionFailureReason, extra: Record<string, unknown> = {}) =>
    ({ promotion: { verdict: 'not_qualified' as const, reason, evaluatedOn: 'holdout' as const, ...extra } as PromotionResult });
  try {
    if (!ctx.signingKey) return nq('signing_unavailable');
    const baselineRef = claimed.request.curatedBaselineRef;
    if (ctx.curated === null || !baselineRef) return nq('curated_unavailable'); // no curated run OR no baseline ref (typing: baselineRef is now non-null below)
    const integrity = evaluatePromotionIntegrity({ candidate: ctx.candidate, curated: ctx.curated, bundleGateRejected: bundleRejected(ctx.bundle) });
    if (integrity.outcome === 'reject') return nq(integrity.reason);
    const epoch = await deps.epochResolver.resolve(claimed);
    if (!epoch || ctx.coverage === null) return nq('holdout_unavailable');
    let window: RunPeriod;
    try { window = computeHoldoutWindow(ctx.coverage, deps.policy.fraction); }
    catch { return nq('holdout_unavailable'); }
    const w = evaluatePromotionWindow({ candidate: ctx.candidate, curated: ctx.curated, holdoutWindow: window,
      runPeriod: claimed.request.period, thresholds: deps.policy.thresholds, policyMetrics: deps.policy.metrics,
      minWarmupBars: deps.policy.minWarmupBars, minTrades: deps.policy.minTrades });
    if (w.outcome === 'reject') return nq(w.reason, { evaluationWindow: window });
    // record REGARDLESS of pass/fail (counter advances for failed too) — verdict computed BEFORE ledger
    const epochKey = computeQualificationEpochKey(
      computePromotionFamilyKey({ trialFamilyHint: claimed.request.trialFamilyHint, moduleRef: { id: claimed.request.moduleRef.id },
        datasetRef: claimed.request.datasetRef, symbols: claimed.request.symbols, timeframe: claimed.request.timeframe }),
      epoch.epochId, deps.policy.policyVersion);
    const attemptIdentity = computeAttemptIdentity(claimed.requestFingerprint, ctx.datasetFingerprint);
    let rec: { attemptNumber: number; inserted: boolean };
    try {
      rec = await deps.ledger.recordIfNewAndGetAttempt({ qualificationEpochKey: epochKey, attemptIdentity,
        requestFingerprint: claimed.requestFingerprint, datasetFingerprint: ctx.datasetFingerprint,
        runId: ctx.runId, resultHash: contentRef(ctx.candidate), verdict: w.verdict, createdAtMs: ctx.clock() });
    } catch { return nq('attempt_record_failed', { evaluationWindow: window }); }
    if (w.verdict === 'failed') return nq('metrics_failed', { attemptNumber: rec.attemptNumber, evaluationWindow: window });
    // passed → sign v2 + PERSIST; 'passed' is returned ONLY if the artifact actually saved
    try {
      const body = buildEvidenceBodyV2({ backtesterRunId: ctx.runId, bundleHash: sha256BundleRef(ctx.bundleBytes),
        keyId: ctx.signingKey.keyId, datasetRef: claimed.request.datasetRef, executionWindow: periodToMs(claimed.request.period),
        symbols: claimed.request.symbols, timeframe: claimed.request.timeframe, evaluationWindow: periodToMs(window),
        candidateHoldoutMetrics: w.candidateHoldoutMetrics, curatedHoldoutMetrics: w.curatedHoldoutMetrics,
        thresholds: deps.policy.thresholds, attemptNumber: rec.attemptNumber, qualificationEpochKey: epochKey,
        candidateResultHash: contentRef(ctx.candidate), curatedResultHash: contentRef(ctx.curated),
        curatedBaselineRef: baselineRef, qualification: { coverage: ctx.coverage,
          fraction: deps.policy.fraction, policyVersion: deps.policy.policyVersion, datasetFingerprint: ctx.datasetFingerprint } });
      const artifact = signEvidence(body, ctx.signingKey.privateKey);
      const artifactId = await ctx.writeArtifact(artifact);
      if (!artifactId) throw new Error('promotion evidence write returned an empty artifact id'); // passed ⟺ a real persisted artifact
      return { promotion: { verdict: 'passed', attemptNumber: rec.attemptNumber, evaluationWindow: window, evaluatedOn: 'holdout' },
        evidenceRef: { artifactId: artifactId as ContentHash, artifactType: 'backtest-evidence/v2', availability: 'available' } };
    } catch {
      return nq('internal_error', { attemptNumber: rec.attemptNumber, evaluationWindow: window });
    }
  } catch {
    return nq('internal_error');   // any unexpected fault: enabled+promotion NEVER returns undefined
  }
}
