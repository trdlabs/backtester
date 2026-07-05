// Shapes are 1:1 with trading-platform/.../evidence-verifier.ts (SignedEvidenceBody / SignedBacktestEvidence).

export interface SignedEvidenceBody {
  readonly schema: 'backtest-evidence/v1';
  readonly backtesterRunId: string;
  readonly bundleHash: string; // sha256:<hex> — lab-provided raw-bytes hash
  readonly verdict: 'passed' | 'failed';
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly keyId: string;
}

export interface SignedBacktestEvidence {
  readonly body: SignedEvidenceBody;
  readonly signature: string;
}

export interface EvidenceScope {
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly symbols: readonly string[];
  readonly timeframe: string;
}

/** Assemble a fully-populated, fixed-shape body. Symbols sorted for determinism (scopeMatches sorts too). */
export function buildEvidenceBody(input: {
  readonly backtesterRunId: string;
  readonly bundleHash: string;
  readonly verdict: 'passed' | 'failed';
  readonly scope: EvidenceScope;
  readonly keyId: string;
}): SignedEvidenceBody {
  return {
    schema: 'backtest-evidence/v1',
    backtesterRunId: input.backtesterRunId,
    bundleHash: input.bundleHash,
    verdict: input.verdict,
    datasetRef: input.scope.datasetRef,
    window: { fromMs: input.scope.window.fromMs, toMs: input.scope.window.toMs },
    symbols: [...input.scope.symbols].sort(),
    timeframe: input.scope.timeframe,
    keyId: input.keyId,
  };
}
