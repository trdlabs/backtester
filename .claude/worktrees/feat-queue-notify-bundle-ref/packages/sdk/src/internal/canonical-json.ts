// Canonical artifact serialization — the determinism core.
//
// Ported verbatim (behavior) from trading-platform `src/research/backtest/canonical-json.ts` (018).
// Invariant: same `request + candles + module versions + seed` => byte-identical output (SC-008).
// Implementation: recursive sorted object keys (array order preserved), numbers quantized via
// decimal.js to a fixed scale (8 places, ROUND_HALF_EVEN), `-0 -> 0`, fixed (non-exponential)
// notation, trailing `\n`. The serializer introduces no wall-clock / host paths / randomness.

import { Decimal } from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/** Fixed quantization scale for numeric fields (decimal places). */
const SCALE = 8;

/** Quantize a number to its canonical string: 8 places, `-0 -> 0`, fixed (non-exponential). */
function quantizeToString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`canonical-json: non-finite number not allowed (got ${n})`);
  }
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0); // normalize `-0 -> 0`
  return d.toFixed(); // fixed notation, no trailing zeros, no exponent
}

/** Quantize a number to the canonical scale (8 places, ROUND_HALF_EVEN) as a `number`. */
export function quantizeContractNumber(n: number): number {
  return Number(quantizeToString(n));
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return quantizeToString(value as number);
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonical-json: unsupported value type "${t}"`);
}

/** Serialize a value to canonical JSON (sorted keys, quantized numbers, trailing `\n`). */
export function canonicalJson(value: unknown): string {
  return `${serialize(value)}\n`;
}
