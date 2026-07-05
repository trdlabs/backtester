import { canonicalJson } from '../../determinism/canonical-json';
import { sha256Hex } from '../../determinism/hash';
import { DEDUP_COMPUTE_VERSION } from './version';

export interface ComputeIdentityInput {
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly sandboxPolicyVersion: string;
}

/** Runid-independent identity of a compute. computeVersion folds in DEDUP_COMPUTE_VERSION so a bump
 *  invalidates the whole cache. bypassCache is intentionally absent — it is not run-affecting. */
export function computeIdentity(input: ComputeIdentityInput): string {
  return sha256Hex(
    canonicalJson({
      requestFingerprint: input.requestFingerprint,
      datasetFingerprint: input.datasetFingerprint,
      computeVersion: DEDUP_COMPUTE_VERSION,
      sandboxPolicyVersion: input.sandboxPolicyVersion,
    }),
  );
}
