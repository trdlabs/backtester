import { DEDUP_TEMPLATE_VERSION, RUNID_SENTINEL } from './version';

export type DedupEngine = 'momentum' | 'overlay' | 'strategy';
export type DedupPayloadKind = 'RunOutcome' | 'BacktestResult';

export interface DedupTemplate {
  readonly engine: DedupEngine;
  readonly payloadKind: DedupPayloadKind;
  readonly templateVersion: string;
  readonly normalizedPayload: unknown;
}

// Deep clone that replaces every occurrence of `from` with `to` inside every string value. Because
// runId is a randomUUID, swapping its substring is exact: it only appears where it (or a derived form
// like `${runId}::variant`) was written, so this covers the woven footprint without enumerating types.
function substitute(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => substitute(v, from, to));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, from, to);
    return out;
  }
  return value;
}

const kindFor = (engine: DedupEngine): DedupPayloadKind =>
  engine === 'momentum' ? 'BacktestResult' : 'RunOutcome';

export function normalize(engine: DedupEngine, payload: unknown, runId: string): DedupTemplate {
  if (JSON.stringify(payload).includes(RUNID_SENTINEL)) {
    throw new Error('dedup: payload already contains the runId sentinel — cannot normalize');
  }
  return {
    engine,
    payloadKind: kindFor(engine),
    templateVersion: DEDUP_TEMPLATE_VERSION,
    normalizedPayload: substitute(payload, runId, RUNID_SENTINEL),
  };
}

export function restamp(template: DedupTemplate, runId: string): unknown {
  return substitute(template.normalizedPayload, RUNID_SENTINEL, runId);
}
