// Live long_oi evidence: real flat-ESM bundle → gate → in-process-vs-sandbox twin → verdict → sign.
//
// curated   = SAME bundle via the IN-PROCESS trusted executor (dynamic import → factory →
//             createTrustedRegistry → runStrategyBacktest with NO router → createTrustedRouter default).
// candidate = SAME bundle via the SANDBOX executor (Docker; buildInlineOverlayRegistry + sandbox router).
//
// produceStrategyEvidence asserts acceptance-gate + twin-equivalence + verdict (from real metrics) and
// signs (abort-before-sign on any gate failure). body.bundleHash = sha256BundleRef(bundleBytes) = the
// lab-pinned raw .mjs bytes (NOT the descriptor's structural hash that materializeBundle recomputes).
//
// Import paths verified against the tree: createTrustedRegistry ← engine/registry.js;
// TRUSTED_REGISTRY_DEFINITION ← engine/registry-definition.js; buildInlineOverlayRegistry ← engine/trusted-registry.js.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import type { CanonicalRowV2, StrategyModule } from '@trading/research-contracts/research';
import { toFixtureFile, fixtureWindow } from './lib/long-oi-fixture.mjs';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { buildInlineOverlayRegistry } from '../src/engine/trusted-registry.js';
import { TRUSTED_REGISTRY_DEFINITION } from '../src/engine/registry-definition.js';
import { createModuleRegistry, createExecutorRouter } from '../src/engine/sandbox/routing.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createSandboxPolicyRegistry, EVIDENCE_LONG_SANDBOX } from '../src/engine/sandbox-policy.js';
import { loadConfig } from '../src/config.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { produceStrategyEvidence } from '../src/evidence/produce-strategy-evidence.js';
import { loadSigningKeyFromPem } from '../src/evidence/signing.js';
import { serializeArtifact } from '../src/evidence/artifact.js';
import type { EvidenceScope } from '../src/evidence/body.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_MJS = '/home/alexxxnikolskiy/projects/trading-lab/.artifacts/long-oi-llm-bundle.mjs';
const EXEC_FIXTURE = resolve(HERE, '../test/fixtures/exec-validation/long-oi-time-exit.json');
const EXPECTED_BUNDLE_HASH = 'sha256:38fe5286dd8152da7a74e043576b2a9333ec23950839cb25289881bfe2c4416c';
const TRUSTED_KEY_ID = 'bt-ed25519-cb1661aa4bcbfff8';
const ENTRY = 'module/index.mjs';

async function main(): Promise<void> {
  // ── (1) signing key — must be the platform-trusted keyId ─────────────────────
  const pem = process.env.BT_EVIDENCE_SIGNING_KEY;
  if (!pem) {
    throw new Error('BT_EVIDENCE_SIGNING_KEY not set — export the PEM from .secrets/bt-evidence-signer.key.pem');
  }
  const key = loadSigningKeyFromPem(pem);
  if (key.keyId !== TRUSTED_KEY_ID) {
    throw new Error(`signing keyId ${key.keyId} != trusted ${TRUSTED_KEY_ID} — admission would fail`);
  }

  // ── (2) raw bundle bytes + hash-pin ──────────────────────────────────────────
  const bundleBytes = readFileSync(BUNDLE_MJS); // lab-pinned raw bytes
  const actualHash = 'sha256:' + createHash('sha256').update(bundleBytes).digest('hex');
  if (actualHash !== EXPECTED_BUNDLE_HASH) {
    throw new Error(`bundleHash ${actualHash} != lab-pinned ${EXPECTED_BUNDLE_HASH}`);
  }
  const entrySource = bundleBytes.toString('utf8');

  // ── (3) extract manifest by importing the Variant-2 factory ──────────────────
  const factory = (await import(pathToFileURL(BUNDLE_MJS).href)).default as (p: unknown) => StrategyModule;
  if (typeof factory !== 'function') throw new Error('bundle default export is not a factory function');
  const manifest = factory(undefined).manifest;
  if (!manifest || manifest.kind !== 'strategy') throw new Error('bundle manifest missing or not kind:strategy');

  // ── (4) inline bundle (single source for gate + materialization) ─────────────
  const inlineBundle = { manifest, entry: ENTRY, files: { [ENTRY]: entrySource } } as unknown as InlineModuleBundle;

  // ── (5) dataset: exec-validation fixture → temp FixtureFile ──────────────────
  const ev = JSON.parse(readFileSync(EXEC_FIXTURE, 'utf8')) as { rowsBySymbol: Record<string, CanonicalRowV2[]> };
  const datasetRef = 'long-oi-3sym-1m';
  const fixture = toFixtureFile(ev, datasetRef, '1m');
  const win = fixtureWindow(fixture.rows);
  const tmpFixtureDir = mkdtempSync(join(tmpdir(), 'long-oi-fixtures-'));
  writeFileSync(join(tmpFixtureDir, `${datasetRef}.json`), JSON.stringify(fixture));
  const dataPort = new FixtureDataPort(tmpFixtureDir);

  // ── (6) shared request — identical for both runs → identical ctx.params ──────
  const risk = TRUSTED_REGISTRY_DEFINITION.riskProfiles[0]!;
  const exec = TRUSTED_REGISTRY_DEFINITION.executionProfiles[0]!;
  const period = { from: new Date(win.fromMs).toISOString(), to: new Date(win.toMs).toISOString() };
  const baselineRequest = {
    runId: 'long-oi-evidence',
    mode: 'research',
    moduleRef: { id: manifest.id, version: manifest.version },
    datasetRef,
    symbols: win.symbols,
    timeframe: '1m',
    period,
    riskProfileRef: { id: risk.id, version: risk.version },
    executionProfileRef: { id: exec.id, version: exec.version },
    seed: 1,
    metrics: ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades'],
  } as unknown as BacktestRunRequest;

  // ── (7) materialize the gated bundle + build the sandbox router ──────────────
  const sp = await materializeBundle(inlineBundle);
  const config = loadConfig();
  // evidence_long@1.0.0: raised stdout/session caps for full-day annotate-heavy runs; isolation unchanged.
  const policy = EVIDENCE_LONG_SANDBOX;
  const sandboxPolicyId = `${policy.id}@${policy.version}`;
  const router = createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: { harnessDir: config.overlaySandbox.harnessDir },
  });

  try {
    const bundle = loadBundle(sp.bundleDir);
    const marketTape = await buildOverlayDataset(dataPort, { datasetRef, symbols: win.symbols, timeframe: '1m', period });

    // curated — SAME bundle, in-process trusted. Mirrors the proven scripts/produce-evidence.mts
    // pattern: createModuleRegistry({strategies:[mod]}) (provenance:'trusted') + explicit
    // createTrustedRouter() → onBarClose runs in-process via InProcessTrustedModuleExecutor.
    //
    // The factory's raw wire-manifest carries `bundleContractVersion` (019 field), which the 017
    // manifest validator rejects (additionalProperties:false). materializeBundle strips it into the
    // on-disk manifest.json, so loadBundle()'s manifest is the clean 017 form — reuse THAT manifest
    // for the in-process module so curated passes the same validation candidate does (identical manifest).
    const curatedModule = { ...factory(manifest.params), manifest: bundle.manifest };
    const curatedRegistry = createModuleRegistry({
      strategies: [curatedModule],
      riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
      executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
    });
    const curated = await runStrategyBacktest(baselineRequest, {
      registry: curatedRegistry,
      marketTape,
      router: createTrustedRouter(),
    });

    // candidate — SAME bundle, sandbox route (Docker)
    const candidate = await runStrategyBacktest(
      { ...baselineRequest, engine: 'strategy' } as BacktestRunRequest,
      { registry: buildInlineOverlayRegistry([], [bundle]), marketTape, router },
    );
    const sandboxErrors = router.errors();
    if (sandboxErrors.length > 0) throw new Error('sandbox execution failed: ' + JSON.stringify(sandboxErrors));

    // ── DIAGNOSTIC: compare per-bar decisions to locate in-process vs sandbox divergence ─────────
    if (process.env.LONGOI_DIAG === '1') {
      if (curated.status !== 'completed' || candidate.status !== 'completed') {
        console.error(`status: curated=${curated.status} candidate=${candidate.status}`);
        if (curated.status === 'rejected') console.error('curated.validation: ' + JSON.stringify(curated.validation, null, 2));
        if (candidate.status === 'rejected') console.error('candidate.validation: ' + JSON.stringify(candidate.validation, null, 2));
        router.closeAll();
        await sp.cleanup();
        return;
      }
      const cur = curated.baseline.decisionRecords;
      const can = candidate.baseline.decisionRecords;
      const sig = (d: { baseDecision: { kind: string; tags?: readonly string[] } }) =>
        `${d.baseDecision.kind}[${(d.baseDecision.tags ?? []).join(',')}]`;
      const tally = (recs: readonly { baseDecision: { kind: string } }[]) => {
        const m: Record<string, number> = {};
        for (const r of recs) m[r.baseDecision.kind] = (m[r.baseDecision.kind] ?? 0) + 1;
        return m;
      };
      console.error(JSON.stringify({
        curatedTrades: curated.baseline.trades.length,
        candidateTrades: candidate.baseline.trades.length,
        curatedRecords: cur.length,
        candidateRecords: can.length,
        curatedKinds: tally(cur),
        candidateKinds: tally(can),
      }, null, 2));
      const n = Math.min(cur.length, can.length);
      let shown = 0;
      for (let i = 0; i < n && shown < 8; i += 1) {
        if (sig(cur[i]!) !== sig(can[i]!)) {
          console.error(`DIVERGE idx=${i} ts=${cur[i]!.barTs} sym=${cur[i]!.symbol} hook=${cur[i]!.hook} curated=${sig(cur[i]!)} candidate=${sig(can[i]!)}`);
          shown += 1;
        }
      }
      if (shown === 0) console.error('no per-record baseDecision divergence in the common prefix');
      router.closeAll();
      await sp.cleanup();
      return;
    }

    // scope — what the platform verifies via scopeMatches
    const scope: EvidenceScope = { datasetRef, window: { fromMs: win.fromMs, toMs: win.toMs }, symbols: win.symbols, timeframe: '1m' };

    // gate → twin-equivalence → verdict → sign (throws before signing on any failure)
    const result = produceStrategyEvidence({
      bundle,
      bundleBytes,
      curated,
      candidate,
      scope,
      key,
      backtesterRunId: 'bt-long-oi-3sym',
    });

    const outDir = resolve(HERE, '../.evidence-out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${result.artifactRef.replace(':', '_')}.json`), serializeArtifact(result.artifact));
    writeFileSync(join(outDir, 'signer.pub.json'), JSON.stringify({ keyId: key.keyId, publicKeyPem: key.publicKeyPem }, null, 2));
    // Audit trail (NOT part of the signed body, which is fixed schema): records the sandbox policy
    // the candidate ran under so a verifier can audit the isolation profile behind the evidence.
    writeFileSync(join(outDir, `${result.artifactRef.replace(':', '_')}.audit.json`), JSON.stringify(
      { artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId, sandboxPolicyId, symbols: win.symbols, window: { fromMs: win.fromMs, toMs: win.toMs } },
      null,
      2,
    ));
    console.log(JSON.stringify(
      { artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId, sandboxPolicyId, symbols: win.symbols, window: { fromMs: win.fromMs, toMs: win.toMs } },
      null,
      2,
    ));
  } finally {
    router.closeAll();
    await sp.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
