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
import { createTrustedRegistry } from '../src/engine/registry.js';
import { buildInlineOverlayRegistry } from '../src/engine/trusted-registry.js';
import { TRUSTED_REGISTRY_DEFINITION } from '../src/engine/registry-definition.js';
import { createExecutorRouter } from '../src/engine/sandbox/routing.js';
import { createSandboxPolicyRegistry } from '../src/engine/sandbox-policy.js';
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
  const policy = config.overlaySandbox.policy;
  const router = createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: { harnessDir: config.overlaySandbox.harnessDir },
  });

  try {
    const bundle = loadBundle(sp.bundleDir);
    const marketTape = await buildOverlayDataset(dataPort, { datasetRef, symbols: win.symbols, timeframe: '1m', period });

    // curated — SAME bundle, in-process trusted (no router → createTrustedRouter default)
    const curatedModule = factory(manifest.params);
    const curatedRegistry = createTrustedRegistry({
      strategies: [curatedModule],
      riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
      executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
    });
    const curated = await runStrategyBacktest(baselineRequest, { registry: curatedRegistry, marketTape });

    // candidate — SAME bundle, sandbox route (Docker)
    const candidate = await runStrategyBacktest(
      { ...baselineRequest, engine: 'strategy' } as BacktestRunRequest,
      { registry: buildInlineOverlayRegistry([], [bundle]), marketTape, router },
    );
    const sandboxErrors = router.errors();
    if (sandboxErrors.length > 0) throw new Error('sandbox execution failed: ' + JSON.stringify(sandboxErrors));

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
    console.log(JSON.stringify(
      { artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId, symbols: win.symbols, window: { fromMs: win.fromMs, toMs: win.toMs } },
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
