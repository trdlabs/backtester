// E4b — promotion identity keys. Family key is PERIOD-FREE (period-reselection must not split families);
// epoch key uses the trusted resolved epochId; attempt identity includes the data snapshot.
import { canonicalJson } from '../../determinism/canonical-json.js';
import { sha256Hex } from '../../determinism/hash.js';

export interface PromotionFamilyInput {
  readonly trialFamilyHint?: string;
  readonly moduleRef: { readonly id: string };
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
}
export function computePromotionFamilyKey(req: PromotionFamilyInput): string {
  return sha256Hex(canonicalJson({
    hint: req.trialFamilyHint ?? req.moduleRef.id,
    datasetRef: req.datasetRef,
    symbols: [...req.symbols].sort(),
    timeframe: req.timeframe,
  }));
}
export function computeQualificationEpochKey(promotionFamilyKey: string, epochId: string, policyVersion: string): string {
  return sha256Hex(canonicalJson({ promotionFamilyKey, epochId, policyVersion }));
}
export function computeAttemptIdentity(requestFingerprint: string, datasetFingerprint: string): string {
  return sha256Hex(canonicalJson({ requestFingerprint, datasetFingerprint }));
}
