// Exact mirror of trading-platform/src/admissions/verification/evidence-verifier.ts::canonicalizeEvidenceBody.
// MUST stay byte-identical — the platform verifies the Ed25519 signature over these bytes offline.
// Do NOT reuse src/determinism/canonical-json.ts (it quantizes numbers + appends '\n').

/** Deterministic sorted-key serialization — the bytes the Ed25519 signature is computed over. */
export function canonicalizeEvidenceBody(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvidenceBody).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeEvidenceBody(obj[k])}`).join(',')}}`;
}
