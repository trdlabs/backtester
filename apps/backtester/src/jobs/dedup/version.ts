// Dedup compute-semantics version. NOT tied to any package/API version — this is the operator lever
// for cache invalidation. BUMP when a change could alter cached-vs-fresh equivalence:
//   - engine output, the normalize/restamp shape, artifact-persistence semantics, or a sandbox-policy
//     change that affects deterministic output.
// A bump re-keys every cache entry (new computeIdentity space) — safe by construction.
//   '1' → '2' (P3-7): cagr/calmar now annualize over the really-processed unique bar timestamps
//   instead of the requested period, so a partially-covered run yields different (correct) metrics —
//   old cache entries would otherwise return the pre-fix values.
export const DEDUP_COMPUTE_VERSION = '2';

// Shape version of the DedupTemplate envelope itself. Bump if the envelope shape changes.
export const DEDUP_TEMPLATE_VERSION = '1';

// Fixed placeholder runId used in normalized templates. A zero UUID never collides with a real
// randomUUID() runId. normalize() asserts a real payload does not already contain it.
export const RUNID_SENTINEL = '00000000-0000-0000-0000-000000000000';
