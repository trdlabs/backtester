# Long-OI Real-Bundle Evidence Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a signed `backtest-evidence/v1` artifact for the real LLM-authored long_oi flat-ESM bundle by running the full live tract (gate → in-process-vs-sandbox twin-equivalence → verdict → sign), hash-pinned to the lab's `bundleHash` and signed with the trusted keyId `bt-ed25519-cb1661aa4bcbfff8`.

**Architecture:** A standalone operational harness script (`scripts/produce-long-oi-evidence.mts`). It (1) converts the local long_oi exec-validation fixture into a `FixtureFile` dataset in a temp dir, (2) materializes the flat-ESM bundle into a `ModuleBundle`, (3) runs the SAME bundle two ways on the same market tape — **curated** = in-process trusted executor (dynamic `import` → factory → `createTrustedRegistry` → `runStrategyBacktest` with no router) and **candidate** = sandbox executor (Docker, via `buildInlineOverlayRegistry` + sandbox router) — then (4) calls `produceStrategyEvidence(...)` which gates, asserts twin-equivalence, computes the verdict from real metrics, and signs. `bundleHash = sha256BundleRef(bundleBytes)` is the lab-pinned raw `.mjs` bytes. This does NOT modify the existing `produceStrategyEvidenceForBundle` driver (which assumes a trusted-registry twin); we call `produceStrategyEvidence` directly with the two RunOutcomes we build.

**Tech Stack:** TypeScript `.mts` run via `tsx`, Node `crypto` (Ed25519), Docker (sandbox candidate run), Vitest only for a tiny converter unit check.

## Global Constraints

- **keyId MUST be `bt-ed25519-cb1661aa4bcbfff8`** — supplied via env `BT_EVIDENCE_SIGNING_KEY` (PEM at `.secrets/bt-evidence-signer.key.pem`). NEVER sign with an ephemeral/other key (admission fails: keyId not in platform trustedSigners). Verify keyId before signing.
- **bundleHash MUST be `sha256:38fe5286dd8152da7a74e043576b2a9333ec23950839cb25289881bfe2c4416c`** — the lab's pinned raw-bytes hash. The harness asserts `sha256BundleRef(bundleBytes) === <that>` before signing; abort on mismatch.
- **NEVER sign `verdict:'passed'` unless `produceStrategyEvidence` computed it from real metrics.** All gates (acceptance-gate, twin-equivalence, verdict) live inside `produceStrategyEvidence` and throw before signing — do not bypass them.
- **Canonicalization / signature / body shape** are owned by `src/evidence/{body,signing,artifact}.ts` — do NOT reimplement; call them via `produceStrategyEvidence`. (Platform interop contract is the pinned gortex memory "Signed backtest-evidence interop contract".)
- Bundle path: `/home/alexxxnikolskiy/projects/trading-lab/.artifacts/long-oi-llm-bundle.mjs`. Source dataset: `apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json` (3 symbols LABUSDT/BEATUSDT/SIRENUSDT, 2026-06-18 00:00→23:59Z, 1m, full OI/liq).
- Run from repo root `/home/alexxxnikolskiy/projects/trading-backtester`. Docker must be available (it is).
- Scope of this plan = the 3-symbol subset (first live admission). The 11-symbol scale-up (convert `2026-06-18-real-all` snapshot) is a follow-up, out of scope here.

---

### Task 1: Dataset converter — exec-validation fixture → FixtureFile

**Files:**
- Create: `apps/backtester/scripts/lib/long-oi-fixture.mts`
- Test: `apps/backtester/test/long-oi-fixture.test.ts`

**Interfaces:**
- Produces: `export function toFixtureFile(execValidation: { rowsBySymbol: Record<string, CanonicalRowV2[]> }, datasetRef: string, timeframe: string): { datasetRef: string; timeframe: string; rows: CanonicalRowV2[] }` — flattens `rowsBySymbol` into a single `rows[]` array (each row already carries `symbol` + `minute_ts` + OHLCV + OI/liq/funding/taker fields). Also `export function fixtureWindow(rows): { fromMs: number; toMs: number; symbols: string[] }` returning the min `minute_ts`, max `minute_ts + 60_000`, and sorted unique symbols.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/long-oi-fixture.test.ts
import { describe, expect, it } from 'vitest';
import { toFixtureFile, fixtureWindow } from '../scripts/lib/long-oi-fixture.mjs';

const SAMPLE = {
  rowsBySymbol: {
    BBB: [
      { schema_version: 2, symbol: 'BBB', minute_ts: 1000, open: 1, high: 1, low: 1, close: 1, volume: 0, turnover: 0, oi_total_usd: 5, funding_rate: 0, liq_long_usd: 0, liq_short_usd: 0, has_oi: true, has_funding: true, has_liquidations: true, taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: true },
    ],
    AAA: [
      { schema_version: 2, symbol: 'AAA', minute_ts: 60000, open: 2, high: 2, low: 2, close: 2, volume: 0, turnover: 0, oi_total_usd: 9, funding_rate: 0, liq_long_usd: 0, liq_short_usd: 0, has_oi: true, has_funding: true, has_liquidations: true, taker_buy_volume_usd: 0, taker_sell_volume_usd: 0, has_taker_flow: true },
    ],
  },
};

describe('long-oi fixture converter', () => {
  it('flattens rowsBySymbol into a single rows array preserving fields', () => {
    const f = toFixtureFile(SAMPLE as never, 'long-oi-3sym-1m', '1m');
    expect(f.datasetRef).toBe('long-oi-3sym-1m');
    expect(f.timeframe).toBe('1m');
    expect(f.rows).toHaveLength(2);
    expect(f.rows.every((r) => typeof r.oi_total_usd === 'number' && r.has_oi === true)).toBe(true);
  });

  it('computes window [minTs, maxTs+60s) and sorted unique symbols', () => {
    const w = fixtureWindow(toFixtureFile(SAMPLE as never, 'x', '1m').rows);
    expect(w.fromMs).toBe(1000);
    expect(w.toMs).toBe(60000 + 60000);
    expect(w.symbols).toEqual(['AAA', 'BBB']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/long-oi-fixture.test.ts`
Expected: FAIL — `Cannot find module '../scripts/lib/long-oi-fixture.mjs'`.

- [ ] **Step 3: Implement the converter**

```typescript
// apps/backtester/scripts/lib/long-oi-fixture.mts
import type { CanonicalRowV2 } from '@trading/research-contracts/research';

export interface FixtureFile {
  readonly datasetRef: string;
  readonly timeframe: string;
  readonly rows: CanonicalRowV2[];
}

/** Flatten exec-validation `rowsBySymbol` into a flat FixtureFile.rows[] (each row keeps its `symbol`). */
export function toFixtureFile(
  execValidation: { rowsBySymbol: Record<string, CanonicalRowV2[]> },
  datasetRef: string,
  timeframe: string,
): FixtureFile {
  const rows: CanonicalRowV2[] = [];
  for (const symbol of Object.keys(execValidation.rowsBySymbol)) {
    for (const r of execValidation.rowsBySymbol[symbol]!) rows.push(r);
  }
  return { datasetRef, timeframe, rows };
}

/** Min ts, max ts + one bar (60s), and sorted unique symbols across all rows. */
export function fixtureWindow(rows: readonly CanonicalRowV2[]): {
  fromMs: number;
  toMs: number;
  symbols: string[];
} {
  let fromMs = Infinity;
  let toMs = -Infinity;
  const symbols = new Set<string>();
  for (const r of rows) {
    fromMs = Math.min(fromMs, r.minute_ts);
    toMs = Math.max(toMs, r.minute_ts + 60_000);
    symbols.add(r.symbol);
  }
  return { fromMs, toMs, symbols: [...symbols].sort() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/long-oi-fixture.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the real fixture converts and matches the known window**

Run:
```bash
npx tsx -e '
import { readFileSync } from "node:fs";
import { toFixtureFile, fixtureWindow } from "./apps/backtester/scripts/lib/long-oi-fixture.mjs";
const ev = JSON.parse(readFileSync("apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json","utf8"));
const f = toFixtureFile(ev, "long-oi-3sym-1m", "1m");
const w = fixtureWindow(f.rows);
console.log(JSON.stringify({ rows: f.rows.length, symbols: w.symbols, fromMs: w.fromMs, toMs: w.toMs }));
'
```
Expected: `rows: 4104`, `symbols: ["BEATUSDT","LABUSDT","SIRENUSDT"]`, window covering 2026-06-18.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/scripts/lib/long-oi-fixture.mts apps/backtester/test/long-oi-fixture.test.ts
git commit -m "feat(evidence): long_oi exec-validation → FixtureFile converter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Verify the inline-bundle wire shape and InlineModuleBundle type

**Files:**
- Read-only: `apps/backtester/src/engine/sandbox/bundle.ts`, `apps/backtester/src/engine/sandbox/bundle-materialize.ts`, the `ModuleBundle` (InlineModuleBundle) type in `@trading/research-contracts`.

**Interfaces:**
- Produces (knowledge, not code): the exact `InlineModuleBundle` field set (`manifest`, `entry`, `files`, and whether a `bundleHash`/descriptor field is required) so Task 3 builds a valid object that `materializeBundle` accepts and `loadBundle` round-trips.

- [ ] **Step 1: Print the InlineModuleBundle type and materializeBundle input shape**

Run:
```bash
npx tsx -e '
import { readFileSync } from "node:fs";
const f = "node_modules/.pnpm/@trading-platform+sdk@*/node_modules/@trading-platform/sdk/dist/research-contract/*.d.ts";
' 2>/dev/null
grep -rn "interface ModuleBundle" node_modules/.pnpm/*/node_modules/@trading-platform/sdk/dist/research-contract/*.d.ts | head
```
Then read the matched interface (record the fields: `manifest`, `entry`, `files: Record<string,string>`, and any `bundleHash`/`contractVersion`). Also read `materializeBundle` (`apps/backtester/src/engine/sandbox/bundle-materialize.ts`) to confirm what it reads off the inline object and what `bundle.json` descriptor it writes (esp. whether it computes `bundleHash` from `files[entry]` or expects it on the input).

- [ ] **Step 2: Confirm raw-bytes round-trip**

Run:
```bash
node -e '
const { readFileSync } = require("fs");
const { createHash } = require("crypto");
const buf = readFileSync("/home/alexxxnikolskiy/projects/trading-lab/.artifacts/long-oi-llm-bundle.mjs");
const asStr = buf.toString("utf8");
const back = Buffer.from(asStr, "utf8");
console.log("utf8 round-trips byte-identical:", buf.equals(back));
console.log("sha256:", "sha256:" + createHash("sha256").update(buf).digest("hex"));
'
```
Expected: `utf8 round-trips byte-identical: true` and `sha256: sha256:38fe5286…2c4416c`. (If round-trip is false, Task 3 must keep `files[entry]` as the raw buffer’s latin1/base64 representation — but for valid UTF-8 ESM it will be true.)

- [ ] **Step 3: Record findings inline in the harness file header (no commit yet — folds into Task 3).**

---

### Task 3: The evidence harness — build inputs, run twin, sign

**Files:**
- Create: `apps/backtester/scripts/produce-long-oi-evidence.mts`

**Interfaces:**
- Consumes: `toFixtureFile`/`fixtureWindow` (Task 1); `materializeBundle` (`src/engine/sandbox/bundle-materialize.js`), `loadBundle` (`src/engine/sandbox/bundle.js`), `buildOverlayDataset` (`src/engine/data-adapter.js`), `runStrategyBacktest` (`src/engine/run-strategy.js`), `createTrustedRegistry`/`buildInlineOverlayRegistry` (`src/engine/trusted-registry.js`), `createExecutorRouter` (`src/engine/sandbox/routing.js`), `createSandboxPolicyRegistry` (`src/engine/sandbox-policy.js`), `loadConfig` (`src/config.js`), `FixtureDataPort` (`src/data/reader.js`), `produceStrategyEvidence` (`src/evidence/produce-strategy-evidence.js`), `loadSigningKeyFromPem` (`src/evidence/signing.js`), `sha256BundleRef`/`serializeArtifact` (`src/evidence/artifact.js`), `EvidenceScope` (`src/evidence/body.js`).
- Produces: an executable harness that writes `apps/backtester/.evidence-out/<artifactRef>.json` + `signer.pub.json` and prints `{ artifactRef, bundleHash, verdict, keyId }`.

- [ ] **Step 1: Write the harness**

```typescript
// apps/backtester/scripts/produce-long-oi-evidence.mts
// Live long_oi evidence: real flat-ESM bundle → gate → in-process-vs-sandbox twin → verdict → sign.
// curated = SAME bundle via in-process trusted executor (dynamic import → factory → trusted registry).
// candidate = SAME bundle via sandbox (Docker). produceStrategyEvidence asserts twin-equivalence,
// computes verdict from real metrics, and signs (abort-before-sign on any gate failure).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { BacktestRunRequest, CanonicalRowV2, ModuleBundle as InlineModuleBundle, StrategyModule } from '@trading/research-contracts';
import { toFixtureFile, fixtureWindow } from './lib/long-oi-fixture.mjs';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { createTrustedRegistry, buildInlineOverlayRegistry, TRUSTED_REGISTRY_DEFINITION } from '../src/engine/trusted-registry.js';
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
const ENTRY = 'module/index.mjs';

async function main(): Promise<void> {
  // ── key (must be the trusted keyId) ──────────────────────────────────────────
  const pem = process.env.BT_EVIDENCE_SIGNING_KEY;
  if (!pem) throw new Error('BT_EVIDENCE_SIGNING_KEY not set — export the PEM from .secrets/bt-evidence-signer.key.pem');
  const key = loadSigningKeyFromPem(pem);
  if (key.keyId !== 'bt-ed25519-cb1661aa4bcbfff8') {
    throw new Error(`signing keyId ${key.keyId} != trusted bt-ed25519-cb1661aa4bcbfff8 — admission would fail`);
  }

  // ── bundle bytes + hash pin ──────────────────────────────────────────────────
  const bundleBytes = readFileSync(BUNDLE_MJS); // raw bytes (lab-pinned)
  const actualHash = 'sha256:' + createHash('sha256').update(bundleBytes).digest('hex');
  if (actualHash !== EXPECTED_BUNDLE_HASH) {
    throw new Error(`bundleHash ${actualHash} != lab-pinned ${EXPECTED_BUNDLE_HASH}`);
  }
  const entrySource = bundleBytes.toString('utf8');

  // ── extract manifest by importing the factory (Variant-2 flat ESM) ───────────
  const factory = (await import(pathToFileURL(BUNDLE_MJS).href)).default as (p: unknown) => StrategyModule;
  if (typeof factory !== 'function') throw new Error('bundle default export is not a factory function');
  const manifest = factory(undefined as never).manifest;
  if (!manifest || manifest.kind !== 'strategy') throw new Error('bundle manifest missing or not kind:strategy');

  // ── inline bundle (single source for gate + materialization) ─────────────────
  const inlineBundle: InlineModuleBundle = { manifest, entry: ENTRY, files: { [ENTRY]: entrySource } } as InlineModuleBundle;

  // ── dataset: convert exec-validation fixture → temp FixtureFile ──────────────
  const ev = JSON.parse(readFileSync(EXEC_FIXTURE, 'utf8')) as { rowsBySymbol: Record<string, CanonicalRowV2[]> };
  const datasetRef = 'long-oi-3sym-1m';
  const fixture = toFixtureFile(ev, datasetRef, '1m');
  const win = fixtureWindow(fixture.rows);
  const tmpFixtureDir = mkdtempSync(join(tmpdir(), 'long-oi-fixtures-'));
  writeFileSync(join(tmpFixtureDir, `${datasetRef}.json`), JSON.stringify(fixture));
  const dataPort = new FixtureDataPort(tmpFixtureDir);

  // ── shared backtest request (both runs use identical request → identical ctx.params) ─
  const baselineRequest = {
    runId: 'long-oi-evidence', mode: 'research',
    moduleRef: { id: manifest.id, version: manifest.version },
    datasetRef, symbols: win.symbols, timeframe: '1m',
    period: { from: new Date(win.fromMs).toISOString(), to: new Date(win.toMs).toISOString() },
    riskProfileRef: { id: TRUSTED_REGISTRY_DEFINITION.riskProfiles[0]!.id, version: TRUSTED_REGISTRY_DEFINITION.riskProfiles[0]!.version },
    executionProfileRef: { id: TRUSTED_REGISTRY_DEFINITION.executionProfiles[0]!.id, version: TRUSTED_REGISTRY_DEFINITION.executionProfiles[0]!.version },
    seed: 1, metrics: ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades'],
  } as unknown as BacktestRunRequest;

  // ── materialize + load the gated bundle ──────────────────────────────────────
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
    const marketTape = await buildOverlayDataset(dataPort, { datasetRef, symbols: win.symbols, timeframe: '1m', period: baselineRequest.period });

    // curated = SAME bundle, in-process trusted (dynamic import factory → trusted registry, no router)
    const curatedModule = factory(manifest.params);
    const curatedRegistry = createTrustedRegistry({
      strategies: [curatedModule],
      riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
      executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
    });
    const curated = await runStrategyBacktest(baselineRequest, { registry: curatedRegistry, marketTape });

    // candidate = SAME bundle, sandbox route (Docker)
    const candidate = await runStrategyBacktest(
      { ...baselineRequest, engine: 'strategy' } as BacktestRunRequest,
      { registry: buildInlineOverlayRegistry([], [bundle]), marketTape, router },
    );
    const sandboxErrors = router.errors();
    if (sandboxErrors.length > 0) throw new Error('sandbox execution failed: ' + JSON.stringify(sandboxErrors));

    // scope (must match what platform admission expects to verify scopeMatches)
    const scope: EvidenceScope = { datasetRef, window: { fromMs: win.fromMs, toMs: win.toMs }, symbols: win.symbols, timeframe: '1m' };

    // gate → twin-equivalence → verdict → sign (throws before signing on any failure)
    const result = produceStrategyEvidence({
      bundle, bundleBytes, curated, candidate, scope, key, backtesterRunId: 'bt-long-oi-3sym',
    });

    const outDir = resolve(HERE, '../.evidence-out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${result.artifactRef.replace(':', '_')}.json`), serializeArtifact(result.artifact));
    writeFileSync(join(outDir, 'signer.pub.json'), JSON.stringify({ keyId: key.keyId, publicKeyPem: key.publicKeyPem }, null, 2));
    console.log(JSON.stringify({ artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId }, null, 2));
  } finally {
    router.closeAll();
    await sp.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
```

- [ ] **Step 2: Type-check the harness compiles (no run yet)**

Run: `npx tsc -p apps/backtester/tsconfig.json --noEmit 2>&1 | grep -E "produce-long-oi-evidence|long-oi-fixture" || echo "no type errors in new files"`
Expected: `no type errors in new files`. Fix any import-path / type mismatches inline (esp. `InlineModuleBundle` field names from Task 2, `createTrustedRegistry` / `buildInlineOverlayRegistry` / `TRUSTED_REGISTRY_DEFINITION` actual exported names — adjust imports to the real symbols if the names differ).

- [ ] **Step 3: Commit the harness (before the live run, so the run is reproducible from a committed state)**

```bash
git add apps/backtester/scripts/produce-long-oi-evidence.mts
git commit -m "feat(evidence): live long_oi evidence harness (in-process vs sandbox twin)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Live run, verify, and hand back the artifact

**Files:**
- Runs: `apps/backtester/scripts/produce-long-oi-evidence.mts`; reads output under `apps/backtester/.evidence-out/`.

- [ ] **Step 1: Run the harness with the trusted key (Docker required)**

Run:
```bash
BT_EVIDENCE_SIGNING_KEY="$(cat .secrets/bt-evidence-signer.key.pem)" npx tsx apps/backtester/scripts/produce-long-oi-evidence.mts
```
Expected (success): JSON with `"verdict": "passed"`, `"bundleHash": "sha256:38fe5286…2c4416c"`, `"keyId": "bt-ed25519-cb1661aa4bcbfff8"`, and a non-empty `artifactRef`.

Expected failure modes (each is informative, NOT a silent pass):
- `equivalence failed at trade #… / result_hash mismatch` → in-process and sandbox diverged; STOP and debug (params/clock/seed/market-tape), do not work around.
- `verdict failed — not signing` → real metrics did not pass the verdict policy on this dataset; STOP and report (never hand-edit to 'passed').
- `bundle validation rejected` → acceptance-gate rejected the manifest/descriptor; STOP and return to lab.
- `sandbox execution failed` → container crash; inspect, fix harness/policy wiring.

- [ ] **Step 2: Independently verify the signed artifact (signature + hash-pin + keyId + scope)**

Run:
```bash
npx tsx -e '
import { readFileSync, readdirSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const dir = "apps/backtester/.evidence-out";
const file = readdirSync(dir).find((f) => f.startsWith("sha256_") && f.endsWith(".json"));
const art = JSON.parse(readFileSync(`${dir}/${file}`,"utf8"));
const pub = JSON.parse(readFileSync(`${dir}/signer.pub.json`,"utf8"));
// canonicalize MUST mirror platform: sorted-key stableStringify, no trailing newline, no quantization
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k)=>JSON.stringify(k)+":"+stable(v[k])).join(",")}}`
  : JSON.stringify(v);
const ok = verify(null, Buffer.from(stable(art.body),"utf8"), createPublicKey(pub.publicKeyPem), Buffer.from(art.signature,"base64"));
console.log(JSON.stringify({ signatureValid: ok, keyId: art.body.keyId, bundleHash: art.body.bundleHash, verdict: art.body.verdict, symbols: art.body.symbols, schema: art.body.schema }, null, 2));
'
```
Expected: `signatureValid: true`, `keyId: bt-ed25519-cb1661aa4bcbfff8`, `bundleHash: sha256:38fe5286…2c4416c`, `verdict: passed`, `schema: backtest-evidence/v1`, symbols `["BEATUSDT","LABUSDT","SIRENUSDT"]`. (This re-verification uses an INDEPENDENT canonicalizer mirroring the platform's `canonicalizeEvidenceBody` — if `signatureValid` is false here, the platform verifier will also reject; STOP and reconcile canonicalization with `src/evidence/body.ts`/`signing.ts`.)

- [ ] **Step 3: Report the artifact path + summary back to the user/platform**

Print the artifact path (`apps/backtester/.evidence-out/<file>`), the full body, and the signature so the platform can run `verifySignedEvidence` and close admission. Note that `.evidence-out/` is gitignored (artifact is a deliverable, not committed).

- [ ] **Step 4: Update memory**

Append the outcome (artifactRef, verdict, scope=3 symbols, equivalence held y/n) to the `evidence-signing-key` / a new `long-oi-evidence` memory, and note the 11-symbol scale-up as the remaining follow-up.

---

## Self-Review

**Spec coverage:**
- validate (acceptance-gate) → Task 3 via `produceStrategyEvidence` (gate is step 1 inside it). ✓
- backtest on our dataset → Task 1 (converter) + Task 3 (curated in-process + candidate sandbox on the long_oi fixture). ✓
- sign with Ed25519 keyId bt-ed25519-cb1661aa4bcbfff8 → Task 3 (keyId asserted) + Global Constraints. ✓
- hash-pin body.bundleHash = sha256:38fe5286… → Task 3 (asserted before sign) + Task 4 step 2 (verified). ✓
- twin-equivalence (in-process vs sandbox) → Task 3 (two runs) + `produceStrategyEvidence` equivalence gate. ✓
- return signed artifact → Task 4 step 3. ✓
- scope = 3 symbols (decided) → Task 1/3 (win.symbols) + scope in body; Task 4 verifies symbols. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; all code shown verbatim. Task 2 is a verification task (read real types) feeding Task 3’s imports — its only "fill-in" is adjusting import names to the real exported symbols, which Step 2 of Task 3 (tsc) enforces concretely.

**Type consistency:** `toFixtureFile`/`fixtureWindow` signatures match between Task 1 definition and Task 3 import. `InlineModuleBundle` fields (`manifest`/`entry`/`files`) are verified in Task 2 before use in Task 3. `produceStrategyEvidence` input keys (`bundle`,`bundleBytes`,`curated`,`candidate`,`scope`,`key`,`backtesterRunId`) match the interface read earlier. `EvidenceScope` shape (`datasetRef`,`window:{fromMs,toMs}`,`symbols`,`timeframe`) matches `body.ts`.

**Risk note:** The two load-bearing risks (twin-equivalence divergence; verdict ≠ passed) are surfaced as explicit STOP-and-report failure modes in Task 4 Step 1 — neither is worked around. The harness signs ONLY through `produceStrategyEvidence`, which throws before signing on any gate failure.
