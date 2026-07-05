# Strategy-Evidence Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the arrival of a real `long_oi` `kind:'strategy'` bundle a **drop-in** (config/input change, not new code), and close the backtester-side prep that doesn't depend on platform/lab.

**Architecture:** Builds directly on PR #58 (engine strategy-route + `produceStrategyEvidence`). Three independent additions: (1) a reusable end-to-end evidence **driver** that orchestrates materialize→gate→curated+candidate runs→equivalence→sign from a SINGLE bundle source (which also closes the `bundleBytes`↔gated-bundle seam — both are derived from one input, so they can't diverge); (2) a worker-level e2e proving the real `processNextQueued` app-pipeline strategy path; (3) a deterministic signer-pubkey export for the platform keyId allowlist handshake.

**Tech Stack:** TypeScript ESM, vitest, Node crypto (Ed25519). Gate: `pnpm check`.

## Global Constraints

- **Cross-boundary contract NOT changed:** bundle = Вариант 2 (`sha256:`+hex of raw bytes); evidence = `backtest-evidence/v1`, canonical mirror in `src/evidence/canonical.ts`, Ed25519. `produceStrategyEvidence`'s hashing semantics (raw-bytes `sha256BundleRef`, distinct from the structural acceptance-gate hash) are CORRECT and MUST NOT change — independently re-verified. The driver must keep using raw bytes for `bundleHash`.
- **NEVER sign `verdict:'passed'`** except from real `computeMetrics`→`decideVerdict`.
- **byte-parity:** momentum + overlay paths unchanged; all additions are additive.
- **Docker-gated tests** use the SAME guard as existing `*.integration.test.ts` (`describe.skipIf(!DOCKER_AVAILABLE)` from `./store-factories.js`); they must compile + skip cleanly in WSL2.
- **Gate:** `pnpm check` EXIT 0 before PR. Single test: `pnpm exec vitest run <file>` from monorepo root.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/backtester/src/evidence/strategy-evidence-driver.ts` | `produceStrategyEvidenceForBundle` — single-source orchestrator | Create |
| `apps/backtester/test/strategy-evidence-driver.integration.test.ts` | driver e2e on short_after_pump (Docker) | Create |
| `apps/backtester/test/strategy-route-worker.integration.test.ts` | processNextQueued→sandbox→completed (Docker) | Create |
| `apps/backtester/scripts/export-signer-pubkey.mts` | emit {keyId, publicKeyPem} for platform allowlist | Create |
| `apps/backtester/test/export-signer-pubkey.test.ts` | deterministic keyId + shape | Create |

---

## Task 1: `produceStrategyEvidenceForBundle` driver (folds in bundleBytes↔gated single-source)

**Files:**
- Create: `apps/backtester/src/evidence/strategy-evidence-driver.ts`
- Test: `apps/backtester/test/strategy-evidence-driver.integration.test.ts` (Docker-gated)

**Interfaces:**
- Consumes (verify exact signatures via Gortex before writing): `materializeBundle` (`src/engine/sandbox/bundle-materialize.ts`), `loadBundle` (`src/engine/sandbox/bundle.ts`), `runOverlayBacktest` (`src/engine/run-overlay.ts`), `runStrategyBacktest` (`src/engine/run-strategy.ts`), `buildTrustedRegistry`/`buildInlineOverlayRegistry` (`src/engine/trusted-registry.ts`), `buildOverlayDataset` (`src/engine/data-adapter.ts`), the sandbox-router helper used by `test/strategy-route.integration.test.ts` (`buildSandboxStrategyBaselineDeps` in `test/helpers-overlay-sandbox.ts` — if it is test-only, the driver builds the same registry+router inline via `createExecutorRouter` + `buildInlineOverlayRegistry([], [bundle])`; read T6's test to mirror it), `produceStrategyEvidence` + `StrategyEvidenceInput` (`src/evidence/produce-strategy-evidence.ts`), `EvidenceScope` (`src/evidence/body.ts`), `SigningKey` (`src/evidence/signing.ts`), `InlineModuleBundle` (`@trading/research-contracts`).
- Produces:
  ```ts
  interface StrategyEvidenceDriverInput {
    readonly inlineBundle: InlineModuleBundle;        // the single bundle source (wire form)
    readonly bundleBytes: Uint8Array;                 // the EXACT raw ESM bytes the lab pinned (sha256 → bundleHash)
    readonly dataset: { datasetRef: string; symbols: readonly string[]; timeframe: string; period: { from: string; to: string } };
    readonly baselineRequest: BacktestRunRequest;     // curated/candidate run request (moduleRef = bundle manifest)
    readonly scope: EvidenceScope;
    readonly key: SigningKey;
    readonly backtesterRunId: string;
    readonly dataPort: DataPort;                        // for buildOverlayDataset (FixtureDataPort in tests)
  }
  function produceStrategyEvidenceForBundle(input: StrategyEvidenceDriverInput): Promise<ProduceStrategyResult>;
  ```
  Flow: materialize `inlineBundle` once → `loadBundle(bundleDir)` = gated `bundle`; build `marketTape` via `buildOverlayDataset(dataPort, dataset)`; run **curated** = `runOverlayBacktest(baselineRequest, { registry: buildTrustedRegistry(), marketTape })`; run **candidate** = `runStrategyBacktest({ ...baselineRequest, engine: 'strategy' }, { registry: buildInlineOverlayRegistry([], [bundle]), marketTape, router: <sandbox router> })`; then `produceStrategyEvidence({ bundle, bundleBytes: input.bundleBytes, curated, candidate, scope, key, backtesterRunId })`. `finally`: cleanup materialized dir + close router. **Single-source seam closure:** the gated `bundle` and the signed `bundleBytes` both originate from `input.inlineBundle`/`input.bundleBytes` of one call — the caller cannot pass a gated bundle unrelated to the signed bytes. (Do NOT recompute bundleHash from bundleDir — keep lab-pinned raw `bundleBytes` per the cross-boundary contract.)

- [ ] **Step 1: Write the failing Docker-gated test** — model `test/strategy-route.integration.test.ts` exactly for the run wiring; assert the driver returns a signed artifact with `verdict==='passed'`, `bundleHash` matches `/^sha256:[0-9a-f]{64}$/`, and `verifySignedEvidenceLocal(artifact, {[key.keyId]: key.publicKeyPem}).ok === true`. Use `short-after-pump.bundle.json` as `inlineBundle`, `bundleBytes = Buffer.from(JSON.stringify(inlineBundle.files[inlineBundle.entry]))` OR the raw entry-file string the fixture carries (read the fixture shape; pick the raw ESM string bytes — document the choice). `describe.skipIf(!DOCKER_AVAILABLE)`.
- [ ] **Step 2: Run → SKIPPED in WSL2 / would-fail (driver missing).** `pnpm exec vitest run apps/backtester/test/strategy-evidence-driver.integration.test.ts`.
- [ ] **Step 3: Implement `strategy-evidence-driver.ts`** per the flow above (mirror T6 wiring verbatim for the sandbox router + curated/candidate runs).
- [ ] **Step 4: Run test (PASS on Docker / SKIP clean WSL2) + `pnpm typecheck` EXIT 0 + `pnpm exec vitest run apps/backtester/test/strategy-route.integration.test.ts` (the model still green).**
- [ ] **Step 5: Commit** `feat(evidence): produceStrategyEvidenceForBundle driver (single-source bundle→gate→runs→sign)`.

---

## Task 2: worker-level e2e (real app-pipeline strategy path)

**Files:**
- Create: `apps/backtester/test/strategy-route-worker.integration.test.ts` (Docker-gated)

**Interfaces:**
- Consumes: the worker job-submission + drain harness used by `test/async-sandbox-overlap.test.ts` (it already drains overlay+bundle runs through `processNextQueued`/`drainQueue`). Read that test to reuse its store/dataPort/bundle-store setup. `processNextQueued`/`drainQueue` (`src/jobs/worker.ts`), the job submit path (`src/jobs/submit.ts`), `DOCKER_AVAILABLE`/store factories.

- [ ] **Step 1: Write the Docker-gated test** — submit ONE job with `engine: 'strategy'`, the `short_after_pump` bundle (so `bundleHash` is set, materialized via the worker's `sandboxBundleFor`), `moduleRef` = the bundle manifest (`short_after_pump@0.1.0`), a dataset the fixtures provide; drain via the worker; assert the terminal row is `completed` with a non-empty `resultHash`. This proves `processNextQueued`'s strategy branch → sandbox → `runStrategyBacktest` → `completed` end-to-end (the chain previously covered only piecewise: T4 selection + T6 engine route). Model the store/bundle-store/dataPort wiring from `async-sandbox-overlap.test.ts`.
- [ ] **Step 2: Run → SKIP clean in WSL2 / fail-before-impl is N/A (test-only).** Confirm it compiles (`pnpm typecheck`).
- [ ] **Step 3: (no production code — test only).** If a production gap blocks completion (e.g. the worker can't resolve the bundle dataset), STOP and report BLOCKED with specifics.
- [ ] **Step 4: Run on Docker (PASS) + confirm overlay/momentum worker tests unaffected (`pnpm exec vitest run apps/backtester/test/async-sandbox-overlap.test.ts`).**
- [ ] **Step 5: Commit** `test(engine): worker-level e2e — engine:'strategy' job drains through app-pipeline to completed (Docker)`.

---

## Task 3: signer pubkey export (keyId handshake — our half)

**Files:**
- Create: `apps/backtester/scripts/export-signer-pubkey.mts`
- Test: `apps/backtester/test/export-signer-pubkey.test.ts`

**Interfaces:**
- Consumes: `generateSigningKey`/`loadSigningKeyFromPem`/`deriveKeyId`/`SigningKey` (`src/evidence/signing.ts`). The env var name MUST match `produce-evidence.mts` (`BT_EVIDENCE_SIGNING_KEY` — verify by reading `produce-evidence.mts::signingKey`).
- Produces: a script that loads the signing key from `BT_EVIDENCE_SIGNING_KEY` (PEM) if set, else generates one, and prints `{ keyId, publicKeyPem }` as JSON to stdout (and optionally writes `signer.pub.json`). A reusable `exportSignerPublicKey(pemOrUndefined): { keyId: string; publicKeyPem: string }` (export from the .mts or a tiny src helper) so it's unit-testable.

- [ ] **Step 1: Write the failing test** (`apps/backtester/test/export-signer-pubkey.test.ts`):
  - given a fixed PEM private key (generate one in-test via `generateSigningKey`, feed its `privateKeyPem` back through `exportSignerPublicKey`), the returned `keyId` equals `deriveKeyId(publicKey)` and matches `/^bt-ed25519-[0-9a-f]{16}$/`, and `publicKeyPem` is a valid SPKI PEM (`-----BEGIN PUBLIC KEY-----`). Determinism: same PEM in → same keyId out twice.
  Read `deriveKeyId`/`generateSigningKey`/`loadSigningKeyFromPem` to get the exact return shapes (`SigningKey` fields: `keyId`, `publicKeyPem`, `privateKey`/`privateKeyPem` — verify names).
- [ ] **Step 2: Run → fail** `pnpm exec vitest run apps/backtester/test/export-signer-pubkey.test.ts`.
- [ ] **Step 3: Implement `export-signer-pubkey.mts`** with `exportSignerPublicKey()` + a `main()` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` (mirror `produce-evidence.mts`'s main guard). Keep it dependency-free beyond `src/evidence/signing.js`.
- [ ] **Step 4: Run test (PASS) + `pnpm typecheck` EXIT 0.**
- [ ] **Step 5: Commit** `feat(evidence): export-signer-pubkey script (keyId + SPKI PEM for platform trustedSigners)`.

---

## Final
- [ ] `pnpm check` EXIT 0 (typecheck + full suite; Docker integration runs locally).
- [ ] Whole-branch review (model scaled to diff). Fix wave if needed.
- [ ] PR opened, NOT merged without explicit go-ahead.

## Self-Review
**Spec coverage:** A→Task1 (incl. C via single-source); B→Task2; D→Task3. **Placeholders:** flows are concrete; "verify signature via Gortex" notes are real verification instructions against just-shipped symbols, not deferred logic. **Type consistency:** `produceStrategyEvidenceForBundle` returns `ProduceStrategyResult` (same as `produceStrategyEvidence`); `bundleHash` stays raw-bytes `sha256BundleRef`; `DOCKER_AVAILABLE` guard consistent across Tasks 1–2.
