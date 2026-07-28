// Content fingerprint of a materialized tape/dataset (analysis/19 defect #7).
//
// WHY NOT `contentRef`: `contentRef` runs the payload through `canonicalJson`, which quantizes every
// number through decimal.js (8 places, ROUND_HALF_EVEN) — the right thing for an ARTIFACT, whose
// bytes are a contract, and pure waste for a FINGERPRINT, whose only job is to detect that the tape
// changed. On a T2 window that is ~6·N·T Decimal round-trips through a string per run.
//
// The fingerprint is a dedup / drift-detection key, not a hashed artifact: it is NOT part of the
// hashed `RunOutcome` (the platform golden), it travels in the wire summary's `evidence` and in the
// dedup / artifact cache keys. Consequences of this module, taken deliberately:
//   - Golden hashes do not move — no golden hashes a dataset fingerprint.
//   - Fingerprint STRINGS change, so every already-stored dedup / artifact cache entry keyed on the
//     old value misses once and is recomputed. Costly once, never wrong: a miss re-runs, it does not
//     serve stale bytes.
//
// Serialization mirrors `canonicalJson` structurally (sorted object keys, array order preserved,
// `undefined` fields dropped) so the same value always yields the same bytes; only the NUMBER rule
// differs — shortest round-trip decimal (`String(n)`) instead of a quantized Decimal. That rule is
// strictly finer than quantization: two rows that differ below the 8th decimal place quantize to the
// same string but fingerprint differently, i.e. drift detection gets sharper, never blunter.
//
// The non-finite guard is kept verbatim from `canonicalJson`: a NaN/Infinity in market data is bad
// data and must surface at materialization, not be hashed into a stable-looking key.

import { createHash } from 'node:crypto';
import type { ContentHash } from '@trading/research-contracts';

/** Shortest round-trip decimal for a finite number; `-0` normalized to `0` (as in canonicalJson). */
function numberToken(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`dataset-fingerprint: non-finite number not allowed (got ${n})`);
  }
  return n === 0 ? '0' : String(n);
}

function serialize(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  const t = typeof value;
  if (t === 'number') {
    out.push(numberToken(value as number));
    return;
  }
  if (t === 'boolean') {
    out.push(value === true ? 'true' : 'false');
    return;
  }
  if (t === 'string') {
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',');
      const v = value[i];
      if (v === undefined) out.push('null');
      else serialize(v, out);
    }
    out.push(']');
    return;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    out.push('{');
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out.push(',');
      const k = keys[i] as string;
      out.push(JSON.stringify(k), ':');
      serialize(obj[k], out);
    }
    out.push('}');
    return;
  }
  throw new Error(`dataset-fingerprint: unsupported value type "${t}"`);
}

/** Deterministic fingerprint of tape/dataset content. Same shape of ref as `contentRef`. */
export function tapeFingerprint(payload: unknown): ContentHash {
  const out: string[] = [];
  serialize(payload, out);
  return `sha256:${createHash('sha256').update(out.join(''), 'utf8').digest('hex')}`;
}
