# HTTP Strategy-Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `POST /v1/runs` `engine:'strategy'` submit carrying `curatedBaselineRef` emits a signed `backtest-evidence/v1` artifact retrievable via the run result's `evidenceRef` — additively over the existing `resultHash` path.

**Architecture:** The worker's existing strategy branch already runs the candidate (sandbox) for `resultHash`. We add a run-once evidence step: run the trusted curated baseline (in-process, same marketTape), feed curated+candidate into the existing `produceStrategyEvidence` (injected-outcomes primitive), persist the signed artifact to the ArtifactStore, and surface it as `RunResultSummary.evidenceRef`. Signing key comes from env; absent ⇒ evidence off. The whole block is try/caught so any failure leaves the `resultHash` run intact.

**Tech Stack:** TypeScript ESM, vitest, Node crypto (Ed25519), Fastify HTTP, pnpm. Gate: `pnpm check`.

## Global Constraints

- **Frozen contract — NOT changed:** `backtest-evidence/v1`; `canonicalizeEvidenceBody` (sorted-keys, no `\n`, no quantization — byte-mirror of platform `evidence-verifier.ts`); detached Ed25519 over `canonicalize(body)`; `body.bundleHash = sha256BundleRef(rawBytes)` of raw ESM bytes (Вариант 2); `keyId`. Reuse `src/evidence/` — NO new canonicalization/signing.
- **Additive over resultHash:** the existing `engine:'strategy'` → `resultHash` path (lab F1 status:'equivalent') MUST stay green. Evidence is opt-in (`curatedBaselineRef` + configured key); every evidence failure path is swallowed and the run still completes with `resultHash`.
- **`curatedBaselineRef` is backtester-only** (like `engine`): the worker builds `engineRequest` field-by-field and MUST NOT put `curatedBaselineRef` into it — it must never reach the lifted runner / 017 validator / hashed RunOutcome.
- **Curated baseline = shortAfterPump** (only trusted strategy). Long_oi curated absent ⇒ a non-twin candidate diverges ⇒ `produceStrategyEvidence` throws ⇒ caught ⇒ no evidence (correct).
- **No ephemeral keys:** if `BT_EVIDENCE_SIGNING_KEY` is unset, evidence is OFF (an ephemeral keyId is not in the platform allowlist).
- **Gate:** `pnpm check` EXIT 0 before PR. Single test from monorepo root: `pnpm exec vitest run apps/backtester/test/<name>.test.ts`.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/sdk/src/contracts/run.ts` | `curatedBaselineRef?` on BacktestRunRequest; `evidenceRef?` on RunResultSummary | Modify |
| `apps/backtester/src/config.ts` | `evidenceSigningKeyPem?` from env | Modify |
| `apps/backtester/src/jobs/worker.ts` | `WorkerDeps.evidenceSigningKey?`; strategy-branch evidence block | Modify |
| `apps/backtester/src/jobs/overlay-summary.ts` | `toOverlaySummary(..., evidenceRef?)` | Modify |
| wherever WorkerDeps is assembled from AppConfig (HTTP app bootstrap) | load key → dep | Modify |
| `apps/backtester/test/*` | submit-accepts-curatedBaselineRef; config key; summary passthrough; worker e2e | Create/Modify |

---

## Task 1: Contract fields (`curatedBaselineRef`, `evidenceRef`)

**Files:**
- Modify: `packages/sdk/src/contracts/run.ts` (BacktestRunRequest ~line 19-39; RunResultSummary ~line 118)
- Test: `apps/backtester/test/submit-validate.test.ts` (add a case)

**Interfaces:**
- Consumes: `Ref` (run.ts), `ArtifactReference` (artifacts/types).
- Produces: `BacktestRunRequest.curatedBaselineRef?: Ref`; `RunResultSummary.evidenceRef?: ArtifactReference`.

- [ ] **Step 1: Write the failing test** — a strategy submit carrying `curatedBaselineRef` is accepted (not rejected as an unknown field). Model the existing strategy submit-validate cases.

```ts
it("accepts engine:'strategy' submit with curatedBaselineRef", () => {
  // build a valid strategy moduleBundle submit (as the existing strategy tests do) + curatedBaselineRef
  const report = preflightOrSubmitValidate({ /* ...strategy submit... */, curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' } });
  expect(report.status).not.toBe('rejected'); // backtester-only field, accepted like `engine`
});
```
> Find the exact validate entrypoint the existing strategy submit-validate tests use (`search_symbols submit validate`, read `submit-validate.test.ts`). If submit validation runs the platform 017 schema with `additionalProperties:false` on the RAW request, confirm how `engine` is tolerated (it already is — strategy submits work) and mirror that for `curatedBaselineRef`. If `curatedBaselineRef` is rejected, the fix belongs in submit.ts's request handling (treat it as a backtester-only field alongside `engine`), NOT by changing the 017 schema.

- [ ] **Step 2: Run → fails** (field rejected or type error). `pnpm exec vitest run apps/backtester/test/submit-validate.test.ts`

- [ ] **Step 3: Implement** — in `run.ts`, add to `BacktestRunRequest`:
```ts
  /** Backtester-only: trusted baseline ref to compare against for signed evidence (e.g. short_after_pump). Stripped before the lifted runner; never reaches the 017 validator. */
  readonly curatedBaselineRef?: Ref;
```
and to `RunResultSummary`:
```ts
  /** Pointer to the signed backtest-evidence/v1 artifact in the ArtifactStore (present only when evidence was produced). */
  readonly evidenceRef?: ArtifactReference;
```
(Import `ArtifactReference` is already present in run.ts — it types `artifactRefs`.) If submit.ts rejects unknown fields, allow `curatedBaselineRef` there (mirror `engine`).

- [ ] **Step 4: Run → passes.** `pnpm exec vitest run apps/backtester/test/submit-validate.test.ts`

- [ ] **Step 5: Commit**
```bash
git add packages/sdk/src/contracts/run.ts apps/backtester/test/submit-validate.test.ts apps/backtester/src/jobs/submit.ts
git commit -m "feat(contract): additive curatedBaselineRef (request) + evidenceRef (summary)"
```

---

## Task 2: Signing-key config + WorkerDeps dep

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig` ~line 44; `loadConfig` ~line 97)
- Modify: `apps/backtester/src/jobs/worker.ts` (`WorkerDeps` ~line 49)
- Modify: the HTTP-app/worker bootstrap that builds `WorkerDeps` from `AppConfig` (find via `search_symbols buildApp WorkerDeps loadConfig`; likely `src/buildApp.ts` / `src/index.ts`)
- Test: `apps/backtester/test/data-source-config.test.ts` or the existing config test (add a case)

**Interfaces:**
- Consumes: `loadSigningKeyFromPem(pem): SigningKey` (`src/evidence/signing.ts`), `SigningKey { keyId, privateKey: KeyObject, publicKeyPem }`.
- Produces: `AppConfig.evidenceSigningKeyPem?: string`; `WorkerDeps.evidenceSigningKey?: SigningKey`.

- [ ] **Step 1: Write the failing test** — config reads the env var.
```ts
it('loadConfig reads BT_EVIDENCE_SIGNING_KEY into evidenceSigningKeyPem', () => {
  const cfg = loadConfig({ ...minimalEnv, BT_EVIDENCE_SIGNING_KEY: 'PEMDATA' });
  expect(cfg.evidenceSigningKeyPem).toBe('PEMDATA');
  expect(loadConfig(minimalEnv).evidenceSigningKeyPem).toBeUndefined();
});
```
> Read the existing config test to reuse its `minimalEnv` helper + `loadConfig` import.

- [ ] **Step 2: Run → fails.** `pnpm exec vitest run apps/backtester/test/<config-test>.test.ts`

- [ ] **Step 3: Implement.**
  - `config.ts` `AppConfig`: add `readonly evidenceSigningKeyPem?: string;` (with a doc-comment: PEM PKCS8 Ed25519 private key; absent ⇒ evidence signing off).
  - `loadConfig`: `...(env.BT_EVIDENCE_SIGNING_KEY ? { evidenceSigningKeyPem: env.BT_EVIDENCE_SIGNING_KEY } : {})` (mirror the existing optional-field pattern in loadConfig, e.g. dataApiToken).
  - `worker.ts` `WorkerDeps`: add `readonly evidenceSigningKey?: SigningKey;` (import `SigningKey` type from `../evidence/signing.js`).
  - Bootstrap (buildApp/index): when assembling WorkerDeps from config, `...(config.evidenceSigningKeyPem ? { evidenceSigningKey: loadSigningKeyFromPem(config.evidenceSigningKeyPem) } : {})`.

- [ ] **Step 4: Run → passes.** Also `pnpm typecheck` EXIT 0.

- [ ] **Step 5: Commit**
```bash
git add apps/backtester/src/config.ts apps/backtester/src/jobs/worker.ts apps/backtester/src/<bootstrap>.ts apps/backtester/test/<config-test>.test.ts
git commit -m "feat(config): BT_EVIDENCE_SIGNING_KEY → WorkerDeps.evidenceSigningKey (off when absent)"
```

---

## Task 3: `toOverlaySummary` evidenceRef passthrough

**Files:**
- Modify: `apps/backtester/src/jobs/overlay-summary.ts` (`toOverlaySummary` line 13)
- Test: `apps/backtester/test/overlay-summary.test.ts` (Create if absent; else add case) — search for an existing toOverlaySummary test first.

**Interfaces:**
- Consumes: `ArtifactReference`.
- Produces: `toOverlaySummary(outcome, runId, artifactRefs, resultHash, datasetFingerprint, bundleHash?, evidenceRef?)` → `RunResultSummary` with `evidenceRef` when provided.

- [ ] **Step 1: Write the failing test**
```ts
import { toOverlaySummary } from '../src/jobs/overlay-summary.js';
it('toOverlaySummary includes evidenceRef when provided, omits when not', () => {
  const ref = { artifactId: 'sha256:ab', artifactType: 'backtest-evidence', availability: 'available' } as const;
  const withEv = toOverlaySummary(OUTCOME, 'r1', [], 'sha256:hh', 'fp', undefined, ref);
  expect(withEv.evidenceRef).toEqual(ref);
  const without = toOverlaySummary(OUTCOME, 'r1', [], 'sha256:hh', 'fp');
  expect(without.evidenceRef).toBeUndefined();
});
```
> Build `OUTCOME` (a completed RunOutcome) via the same factory used in existing summary/equivalence tests (read one for the shape).

- [ ] **Step 2: Run → fails** (arg not accepted / field absent).

- [ ] **Step 3: Implement** — add a trailing optional param and spread it:
```ts
export function toOverlaySummary(
  outcome: Extract<RunOutcome, { status: 'completed' }>,
  runId: string,
  artifactRefs: readonly ArtifactReference[],
  resultHash: ContentHash,
  datasetFingerprint: string,
  bundleHash?: ContentHash,
  evidenceRef?: ArtifactReference,
): RunResultSummary {
  // ...unchanged body...
  return {
    runId, status: 'completed', metrics: headline.metrics, artifactRefs, evidence, resultHash,
    ...(outcome.comparison != null ? { comparison: outcome.comparison } : {}),
    ...(evidenceRef !== undefined ? { evidenceRef } : {}),
  };
}
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit**
```bash
git add apps/backtester/src/jobs/overlay-summary.ts apps/backtester/test/overlay-summary.test.ts
git commit -m "feat(jobs): toOverlaySummary surfaces optional evidenceRef"
```

---

## Task 4: Worker strategy-branch evidence block (run-once)

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (strategy branch inside `processNextQueued`)
- Test: `apps/backtester/test/strategy-evidence-http.integration.test.ts` (Create, Docker-gated)

**Interfaces:**
- Consumes: `produceStrategyEvidence(input): ProduceStrategyResult` (`src/evidence/produce-strategy-evidence.ts`), `runOverlayBacktest` (`src/engine/run-overlay.ts`), `buildTrustedRegistry` (`src/engine/trusted-registry.ts`), `EvidenceScope` (`src/evidence/body.ts`), `toOverlaySummary(..., evidenceRef?)` (Task 3), `WorkerDeps.evidenceSigningKey` (Task 2), `claimed.request.curatedBaselineRef` (Task 1). Node `readFileSync`, `join`. `deps.artifactStore.write(payload) → ContentHash`. `periodMs(r.period) → { tsFrom, tsTo }` (already in worker.ts).
- Produces: `summary.evidenceRef` when evidence is produced.

- [ ] **Step 1: Write the failing test** (Docker-gated, model `strategy-route-worker.integration.test.ts`):
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';
import { generateSigningKey, verifySignedEvidenceLocal } from '../src/evidence/signing.js';

// ... loadRequest/loadBundle helpers as in strategy-route-worker.integration.test.ts ...

describe.skipIf(!DOCKER_AVAILABLE)('strategy-evidence over HTTP (Docker)', () => {
  it('strategy submit + curatedBaselineRef + signing key → signed evidenceRef, verifiable', async () => {
    const key = generateSigningKey();
    // inject the key via WorkerDeps — buildTestApp must accept an evidenceSigningKey override
    // (extend buildTestApp opts: { evidenceSigningKey?: SigningKey }; thread into WorkerDeps).
    const app = await buildTestApp({ enableOverlayEngine: true, workerConcurrency: 1, evidenceSigningKey: key });
    try {
      const baselineReq = loadRequest('baseline.json');
      const bundle = loadBundle('short-after-pump.bundle.json');
      const runId = 'strat-evidence-1';
      const res = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: {
        ...baselineReq, runId, engine: 'strategy', moduleBundle: bundle,
        metrics: ['pnl', 'win_rate'],
        curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' },
      }});
      expect(res.statusCode).toBe(202);
      expect(await app.drain()).toBe(1);
      const row = await app.store.get(runId);
      expect(row!.status).toBe('completed');
      expect(row!.resultSummary!.evidenceRef).toBeDefined();
      // fetch the signed artifact from the store and verify it
      const artifact = await app.artifactStore.read(row!.resultSummary!.evidenceRef!.artifactId);
      expect(artifact.body.schema).toBe('backtest-evidence/v1');
      expect(artifact.body.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(artifact.body.verdict).toBe('passed');
      expect(verifySignedEvidenceLocal(artifact, { [key.keyId]: key.publicKeyPem }).ok).toBe(true);
    } finally { await app.dispose(); }
  }, 120_000);

  it('strategy submit WITHOUT curatedBaselineRef → completed, no evidenceRef', async () => {
    const app = await buildTestApp({ enableOverlayEngine: true, workerConcurrency: 1, evidenceSigningKey: generateSigningKey() });
    try {
      const baselineReq = loadRequest('baseline.json');
      const res = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: {
        ...baselineReq, runId: 'strat-no-ev', engine: 'strategy', moduleBundle: loadBundle('short-after-pump.bundle.json'), metrics: ['pnl', 'win_rate'],
      }});
      expect(res.statusCode).toBe(202);
      await app.drain();
      const row = await app.store.get('strat-no-ev');
      expect(row!.status).toBe('completed');
      expect(row!.resultSummary!.evidenceRef).toBeUndefined();
    } finally { await app.dispose(); }
  }, 120_000);
});
```
> Verify `buildTestApp` opts + how it builds WorkerDeps (extend it to accept `evidenceSigningKey` and how the app exposes `artifactStore` + `artifactStore.read`). Read `test/helpers.ts::buildTestApp` + the ArtifactStore interface (`read`/`write` names) first. If the store has no `read`, use whatever read accessor exists (e.g. `store.read`/`get`).

- [ ] **Step 2: Run → fails** (no evidenceRef produced; field undefined). Docker pass/skip.

- [ ] **Step 3: Implement the evidence block** in the strategy branch, AFTER `resultHash = contentRef(outcome);` + `persistOverlayArtifacts(...)` and BEFORE `summary = toOverlaySummary(...)`. Read the current strategy branch via `get_symbol_source ...worker.ts::processNextQueued` for the exact local names (`r`, `marketTape`, `sandboxBundle`, `outcome`, `runId`, `engineRequest`).
```ts
let evidenceRef: ArtifactReference | undefined;
if (claimed.request.curatedBaselineRef !== undefined && deps.evidenceSigningKey !== undefined) {
  try {
    const curated = await runOverlayBacktest(
      { ...engineRequest, moduleRef: claimed.request.curatedBaselineRef },
      { registry: buildTrustedRegistry(), marketTape },
    );
    if (curated.status !== 'completed') throw new Error('curated baseline run not completed');
    const entryAbs = join(sandboxBundle!.bundle.bundleDir, sandboxBundle!.bundle.descriptor.entryPoint);
    const bundleBytes = readFileSync(entryAbs);
    const { tsFrom, tsTo } = periodMs(r.period);
    const scope: EvidenceScope = {
      datasetRef: r.datasetRef,
      window: { fromMs: tsFrom, toMs: tsTo },
      symbols: [...r.symbols].sort(),
      timeframe: r.timeframe,
    };
    const result = produceStrategyEvidence({
      bundle: sandboxBundle!.bundle,
      bundleBytes,
      curated,
      candidate: outcome,
      scope,
      key: deps.evidenceSigningKey,
      backtesterRunId: runId,
    });
    const evidenceHash = await deps.artifactStore.write(result.artifact);
    evidenceRef = { artifactId: evidenceHash, artifactType: 'backtest-evidence', availability: 'available' };
  } catch {
    // gate-reject / non-equivalent (non-twin) / verdict!=passed → additive: leave evidenceRef undefined,
    // the run still completes with resultHash. (Do NOT rethrow.)
    evidenceRef = undefined;
  }
}
```
Then thread `evidenceRef` into the existing summary call:
```ts
summary = toOverlaySummary(outcome, runId, persisted.artifactRefs, resultHash, dsFingerprint, claimed.bundleHash, evidenceRef);
```
Add imports to worker.ts: `produceStrategyEvidence` (`../evidence/produce-strategy-evidence.js`), `EvidenceScope` (`../evidence/body.js`), `readFileSync` (`node:fs`), `join` (`node:path`). `runOverlayBacktest`/`buildTrustedRegistry`/`periodMs`/`ArtifactReference` are already imported/in-scope (overlay branch uses them).
> Verify `sandboxBundle.bundle.descriptor.entryPoint` is the correct field for the entry path (read `BundleDescriptor` in `src/engine/sandbox/bundle.ts`). The bytes read from `bundleDir/entryPoint` are the verbatim submitted ESM bytes (Вариант-2 flat) = the lab-pinned raw bytes for `bundleHash`.

- [ ] **Step 4: Run → passes** (Docker). Then regression: `pnpm exec vitest run apps/backtester/test/strategy-route-worker.integration.test.ts apps/backtester/test/overlay-golden.test.ts apps/backtester/test/momentum-guardrail.test.ts` — existing strategy resultHash path + momentum/overlay unchanged. `pnpm typecheck` EXIT 0.

- [ ] **Step 5: Commit**
```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/strategy-evidence-http.integration.test.ts
git commit -m "feat(engine): worker produces signed backtest-evidence on strategy submit (curatedBaselineRef + key)"
```

---

## Final
- [ ] `pnpm check` EXIT 0 (typecheck + full suite; Docker integration runs locally).
- [ ] Whole-branch review (opus). Fix wave if needed.
- [ ] PR opened, NOT merged.
- [ ] PR body notes the cross-repo follow-on: backtester Ed25519 public key (`export-signer-pubkey`) must be added to the platform `trustedSigners` allowlist before live admission.

## Self-Review
**Spec coverage:** §3.1 contract → Task 1; §3.2 key → Task 2; §3.4 retrieval → Task 3; §3.3 worker block + §3.5 error handling → Task 4; §5 tests → Tasks 1-4; §7 follow-on → Final/PR. **Placeholders:** code is concrete; "verify via Gortex" notes target real symbols (buildTestApp opts, ArtifactStore read/write names, descriptor.entryPoint, submit field tolerance) — verification instructions, not deferred logic. **Type consistency:** `evidenceRef?: ArtifactReference` identical in run.ts (Task 1), toOverlaySummary (Task 3), worker (Task 4); `curatedBaselineRef?: Ref` in run.ts (Task 1) read in worker (Task 4); `produceStrategyEvidence` input shape matches src/evidence (verified). **Contract frozen:** evidence/canonical/computeBundleHash untouched; curatedBaselineRef kept out of engineRequest (never hits 017).
