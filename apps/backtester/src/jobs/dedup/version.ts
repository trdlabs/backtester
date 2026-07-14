// Dedup compute-semantics version. NOT tied to any package/API version — this is the operator lever
// for cache invalidation. BUMP when a change could alter cached-vs-fresh equivalence:
//   - engine output, the normalize/restamp shape, artifact-persistence semantics, or a sandbox-policy
//     change that affects deterministic output.
// A bump re-keys every cache entry (new computeIdentity space) — safe by construction.
//   '1' → '2' (P3-7): cagr/calmar now annualize over the really-processed unique bar timestamps
//   instead of the requested period, so a partially-covered run yields different (correct) metrics —
//   old cache entries would otherwise return the pre-fix values.
//   '2' → '3' (P2-19): funding now charges one SERVER-cadence period per processed covered bar (cadence
//   from DatasetDescriptor.timeframe, elapsed-aware stale grace) instead of a gridMinutes extrapolated
//   from the first two bars — a gapped tape yields different (correct) funding/equity, so old cache
//   entries would return the pre-fix values.
export const DEDUP_COMPUTE_VERSION = '3';

// Shape version of the DedupTemplate envelope itself. Bump if the envelope shape changes.
export const DEDUP_TEMPLATE_VERSION = '1';

// Fixed placeholder runId used in normalized templates. A zero UUID never collides with a real
// randomUUID() runId. normalize() asserts a real payload does not already contain it.
export const RUNID_SENTINEL = '00000000-0000-0000-0000-000000000000';
