// Track B harness: backtest (real long_oi data, in-process engine) → verdict → sign → artifact.
// Backtest wiring mirrors scripts/reconcile-report.mts. The sandboxed (Docker) executor path is the FINAL
// long_oi wiring; Track B uses the in-process trusted router so it runs in WSL2/CI.
// NOTE: Track B currently does backtest+sign on a programmatic fixture (makeReconcileReplayModule).
// The bundle-validation gate (validateBundle → rejected ⇒ abort) is NOT active in the current Track-B path —
// it is wired at the real-bundle step via the TODO seam in produceEvidence() below.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBacktest } from '../src/engine/runner.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { computeMetrics } from '../src/engine/metrics.js';
import { makeReconcileReplayModule } from '../test/helpers-reconcile.js';
import { tapeFromRows, type PaperTrade } from '../test/helpers-replay.js';
import type { BacktestRunRequest, CanonicalRowV2, ExecutionProfile } from '@trading/research-contracts/research';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import {
  buildEvidenceBody,
  type EvidenceScope,
  type SignedBacktestEvidence,
} from '../src/evidence/body.js';
import { decideVerdict } from '../src/evidence/verdict.js';
import {
  generateSigningKey,
  loadSigningKeyFromPem,
  signEvidence,
  type SigningKey,
} from '../src/evidence/signing.js';
import { serializeArtifact, artifactRef, sha256BundleRef } from '../src/evidence/artifact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../test/fixtures/exec-validation/long-oi-time-exit.json');

const PAPER_MATCH: ExecutionProfile = {
  id: 'paper_match', version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

function signingKey(): SigningKey {
  const pem = process.env.BT_EVIDENCE_SIGNING_KEY;
  return pem ? loadSigningKeyFromPem(pem) : generateSigningKey();
}

export interface ProduceResult {
  readonly artifact: SignedBacktestEvidence;
  readonly artifactRef: string;
  readonly bundleHash: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly verdict: 'passed' | 'failed';
}

export async function produceEvidence(opts: { fixturePath?: string }): Promise<ProduceResult> {
  // TODO(real-bundle): when the final self-contained long_oi ESM bundle arrives from lab,
  // run the acceptance-gate FIRST and ABORT before signing on rejection:
  //   const v = validateBundle(bundle, platformContractContext([strategyRef]));
  //   if (v.status === 'rejected') throw new Error('bundle validation rejected — return to lab; no evidence emitted');
  // (validateBundle from '../src/engine/sandbox/acceptance-gate.js' ingests the bundleDir/ESM bytes;
  //  platformContractContext from '@trading/research-contracts/research' builds the authoritative ContractContext;
  //  the Track-B reconcile-module fixture is not a ModuleBundle, so the gate is deferred to the real-bundle
  //  wiring — NOT silently dropped.)
  const fixture = JSON.parse(readFileSync(opts.fixturePath ?? FIXTURE, 'utf8')) as {
    trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]>;
  };
  const symbols = Object.keys(fixture.rowsBySymbol).sort();

  // --- run the real engine per symbol; collect equity + trades ---
  const equity: EquityPoint[] = [];
  const trades: Trade[] = [];
  let minTs = Infinity, maxTs = -Infinity;
  for (const symbol of symbols) {
    const rows = fixture.rowsBySymbol[symbol];
    minTs = Math.min(minTs, rows[0]!.minute_ts);
    maxTs = Math.max(maxTs, rows[rows.length - 1]!.minute_ts + 60_000);
    const tape = tapeFromRows(symbol, rows);
    const mod = makeReconcileReplayModule(symbol, fixture.trades.filter((t) => t.symbol === symbol));
    const registry = createModuleRegistry({
      strategies: [mod],
      riskProfiles: [DEFAULT_RISK],
      executionProfiles: [PAPER_MATCH],
    });
    const req = {
      runId: `evidence-${symbol}`, mode: 'research', moduleRef: { id: mod.manifest.id, version: '1.0.0' },
      datasetRef: symbol, symbols: [symbol], timeframe: '1m',
      period: {
        from: new Date(rows[0]!.minute_ts).toISOString(),
        to: new Date(rows[rows.length - 1]!.minute_ts + 60_000).toISOString(),
      },
      riskProfileRef: { id: 'default_risk', version: '1.0.0' },
      executionProfileRef: { id: 'paper_match', version: '1.0.0' },
      seed: 1, metrics: ['pnl'],
    } as unknown as BacktestRunRequest;
    const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
    if (out.status !== 'completed') throw new Error(`run not completed for ${symbol}`);
    equity.push(...out.baseline.evidence.equityCurve);
    trades.push(...out.baseline.trades);
  }

  // --- metrics → verdict ---
  const metrics = computeMetrics(['sharpe', 'max_drawdown', 'win_rate', 'total_trades'], equity, trades, {
    elapsedYears: null,
  });
  const verdict = decideVerdict(metrics);

  // --- bundleHash: raw-bytes sha256 of the self-contained bundle blob (Track B stand-in = fixture bytes) ---
  // The FINAL long_oi run takes bundleHash as a pinned input from lab — do NOT recompute from a directory.
  const bundleBytes = readFileSync(opts.fixturePath ?? FIXTURE);
  const bundleHash = sha256BundleRef(bundleBytes);

  const scope: EvidenceScope = {
    datasetRef: 'long_oi-exec-validation',
    window: { fromMs: minTs, toMs: maxTs },
    symbols,
    timeframe: '1m',
  };
  const key = signingKey();
  const body = buildEvidenceBody({
    backtesterRunId: `bt-${symbols.join('_')}`,
    bundleHash,
    verdict,
    scope,
    keyId: key.keyId,
  });
  const artifact = signEvidence(body, key.privateKey) as SignedBacktestEvidence;
  const bytes = serializeArtifact(artifact);

  return {
    artifact,
    artifactRef: artifactRef(bytes),
    bundleHash,
    keyId: key.keyId,
    publicKeyPem: key.publicKeyPem,
    verdict,
  };
}

async function main(): Promise<void> {
  const result = await produceEvidence({});
  const outDir = resolve(HERE, '../.evidence-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `${result.artifactRef.replace(':', '_')}.json`),
    serializeArtifact(result.artifact),
  );
  writeFileSync(
    resolve(outDir, 'signer.pub.json'),
    JSON.stringify({ keyId: result.keyId, publicKeyPem: result.publicKeyPem }, null, 2),
  );
  console.log(JSON.stringify(
    { artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId },
    null, 2,
  ));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
