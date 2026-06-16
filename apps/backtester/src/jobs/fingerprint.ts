// Request fingerprint for idempotency. sha256 over ONLY the run-affecting fields — orchestration /
// callback / timeout fields are excluded (a replay that changes only those is the same run). Mirrors
// trading-platform `mcp-gateway/handlers/submit-run.ts::fingerprintOf`.

import type { RunSubmitRequest } from '@trading/research-contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { sha256Hex } from '../determinism/hash';

export function requestFingerprint(req: RunSubmitRequest): string {
  const normalized = {
    datasetRef: req.datasetRef,
    moduleRef: req.moduleRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
    params: req.params ?? null,
    seed: req.seed,
    mode: req.mode,
    metrics: req.metrics ?? [],
  };
  return sha256Hex(canonicalJson(normalized));
}
