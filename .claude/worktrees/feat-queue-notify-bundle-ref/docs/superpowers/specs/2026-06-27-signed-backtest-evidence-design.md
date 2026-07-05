# Signed backtest-evidence — design (Track B)

**Date:** 2026-06-27
**Repo:** trading-backtester
**Status:** approved (brainstorming) → ready for implementation plan

## 1. Goal & context

The backtester is the validation/backtest/signing repo in the roadmap. It takes a
self-contained `long_oi` ESM bundle authored in `trading-lab`, runs the kernel
`validate()`, backtests it on real data, and produces a **signed evidence artifact**
that the platform admission pipeline (036 intake → 043 `decideAdmission` → 047 promotion
→ 048 isolated run) consumes as proof of "backtest-first".

This spec covers **Track B**: the full produce-pipeline built and proven end-to-end on a
**fixture module bundle**, on real data, with a signed artifact the platform's offline
verifier accepts. The final `long_oi` bundle from lab is re-run deterministically later;
**only the signature is over the final bundle bytes** (strict serialization point — the
`bundleHash` is pinned to lab's bytes).

### Out of scope (YAGNI)

- Production fetch transport (`ExternalArtifactSource`) — platform/ops concern.
- Anything platform-side (admission, 047, 048).
- USD/sizing, default-flip, paper-port.
- Signing the final bundle now — only a deterministic re-run when lab finalizes.

## 2. Interop contract (read from `trading-platform`, MUST be mirrored byte-for-byte)

Source of truth: `trading-platform/src/admissions/verification/evidence-verifier.ts`
(`verifySignedEvidence`, `canonicalizeEvidenceBody`, `SignedEvidenceBody`,
`SignedBacktestEvidence`, `TrustedSigners`) and `admission/validate.ts`
(`decideAdmission`, `scopeMatches`), `verification/bundle-resolver.ts` (sha256 ref form).

1. **Canonicalization** = platform `canonicalizeEvidenceBody` = sorted-key `stableStringify`:
   recursive, `JSON.stringify` for primitives, `Object.keys(obj).sort()`, arrays serialized
   as `[a,b]`, **no trailing newline, no number quantization**. This is **NOT** RFC 8785 JCS
   and **NOT** the backtester's `src/determinism/canonical-json.ts` /
   `packages/sdk/src/internal/canonical-json.ts` (those add `\n` and quantize). A dedicated
   mirror is required.
2. **Signature** = Ed25519 detached:
   `crypto.sign(null, Buffer.from(canonical(body), 'utf8'), edPrivKey)` → base64.
   Verify is `crypto.verify(null, ...)`.
3. **bundleHash form** = `'sha256:' + createHash('sha256').update(bytes).digest('hex')`
   (lowercase, `/^sha256:[0-9a-f]{64}$/`). Admission triple-hash:
   `bundleBytesSha256 === payload.strategy.moduleBundleHash === body.bundleHash` (string-equal).
   Must equal lab's `bundleHash` byte-for-byte.

   **TRAP — two different "bundle hashes" exist; do not conflate them.** The platform compares
   `sha256(rawBundleBytes)` — the sha256 of the single self-contained bundle byte blob that lab
   ships and the platform's `ExternalArtifactSource` fetches and re-hashes (see
   `trading-platform/.../verification/bundle-resolver.ts` and `external-bundle-resolver.ts`:
   `sha256(fetched.bytes)`). This is **lab's provided `bundleHash` / `moduleBundleHash`**. It is
   **NOT** the backtester's internal `apps/backtester/src/engine/sandbox/bundle-hash.ts::computeBundleHash`,
   which is a *structured* digest `sha256(canonicalJson({ manifestSha256, files[] }))` over a bundle
   **directory** of per-file hashes (used only for acceptance-gate integrity of the multi-file
   `ModuleBundle`). `body.bundleHash` MUST be the lab-provided raw-bytes sha256 — wiring the
   structured `computeBundleHash` there passes our unit tests but fails admission with
   `bundle_backtest_mismatch`. The harness takes `bundleHash` as a **pinned input** (re-verifying it
   by re-hashing the same byte blob the platform will fetch), never recomputed from the directory.
4. **Body shape** (`SignedEvidenceBody`, fixed shape, no optional keys, no `undefined`):
   `schema:'backtest-evidence/v1'`, `backtesterRunId`, `bundleHash`, `verdict:'passed'|'failed'`,
   `datasetRef`, `window:{fromMs,toMs}`, `symbols:string[]`, `timeframe`, `keyId`.
   Artifact = `{ body, signature }`.
5. **scopeMatches**: `payload.evidence` (datasetRef / timeframe / window.fromMs / window.toMs /
   symbols-sorted) must equal the evidence body scope. The evidence body is the source of scope;
   the candidate intake payload mirrors it.
6. **keyId** must be in platform `trustedSigners` (`{ keyId: publicKeyPem SPKI }`). Coordinate
   `pubPem → platform config` (ops). Unknown key ⇒ `signature_invalid`.

**Hard rule:** never sign `verdict:'passed'` unless it was computed from real backtest metrics
by the verdict policy — the platform trusts the signature and makes no runtime call to us.

## 3. Architecture

New module `apps/backtester/src/evidence/`, composed by a harness script. Each unit is pure
and independently testable; the harness wires them to the **existing** `validateBundle` and
backtest host.

### Units

1. **`canonical.ts`** — `canonicalizeEvidenceBody(value: unknown): string`. Exact mirror of the
   platform `stableStringify`. No reuse of the determinism canonical-json.

2. **`body.ts`** — types `SignedEvidenceBody` / `SignedBacktestEvidence` (1:1 with platform) and
   `buildEvidenceBody({ runId, bundleHash, verdict, scope, keyId }): SignedEvidenceBody`. Emits a
   fully-populated fixed-shape object: never `undefined`, never omits a key, `symbols` always an
   array (`[]` not `null`).

3. **`verdict.ts`** — pure `decideVerdict(metrics, thresholds): 'passed' | 'failed'`.
   `EvidenceThresholds` in config with **deliberately conservative defaults**:
   `sharpe > 0`, `maxDrawdownPct < 100`, `winRate > 0` ("at least not pure garbage").
   `// TODO(product): real calibrated gate comes with operational experience — do not hardcode
   arbitrary numbers.` This is the gate that prevents signing `passed` without clearing thresholds.
   Metrics are sourced from the run (drawdown / sharpe derived from `RunEvidence.equityCurve` when
   the chosen host does not surface them directly; `winRate` from run metrics).

4. **`signing.ts`** — Ed25519:
   - `generateSigningKey(): { keyId, publicKeyPem }` (+ private key material handled by caller).
   - `signEvidence(body, privateKey): SignedBacktestEvidence`.
   - `verifySignedEvidence(...)` — local mirror, for self-check in tests only.
   - `keyId = 'bt-ed25519-' + sha256(publicKeyDer).slice(0, 16)` (deterministic, stable).

5. **`artifact.ts`** — `serializeArtifact({ body, signature }): Uint8Array` (stable JSON) and
   `artifactRef(bytes): 'sha256:<hex>'` (content-hash locator, same form as bundleHash).
   `bundleRef` = the already-computed `bundleHash`.

### Harness: `scripts/produce-evidence.mts`

Flow:

```
load(bundleDir, manifest, bundleHash)
  → validateBundle (existing acceptance-gate: kernel validate() + integrity)
       rejected ⇒ ABORT, "return to lab", emit NO evidence
  → backtest on the real slice (existing host; candle fixtures / exec-validation slice)
  → metrics
  → decideVerdict(metrics, thresholds)        // passed | failed
  → buildEvidenceBody({ runId, bundleHash, verdict, scope, keyId })
  → signEvidence(body, privateKey)            // Ed25519 over canonical(body)
  → write { artifact, artifactRef } + (separately) { keyId, publicKeyPem }
```

Re-running on the final lab bundle is deterministic (same bytes → same bundleHash → same scope
→ same artifact, modulo the signature over the final bytes).

### Real data

- Candle fixtures: `apps/backtester/fixtures/candles` + `apps/backtester/test/fixtures/exec-validation`
  (1m slice from the execution-validation harness).
- Canonical `long_oi` scope (symbols + window from `startedAtMs`/`finishedAtMs`) reference:
  `trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`
  (`long_oi_strategy` paper run). This is the scope the evidence carries to pass `scopeMatches`.

### Keys

Private key is injected (`BT_EVIDENCE_SIGNING_KEY` PEM or a path) — **never committed**. Tests use a
clearly-marked throwaway dev key under `test/fixtures`. Only `pubPem + keyId` leave the repo, for the
platform `trustedSigners` handoff.

## 4. Validation kernel (042 single-source assertion)

Reuse the existing `validateBundle` (`apps/backtester/src/engine/sandbox/acceptance-gate.ts`) — it
already runs the 017 kernel `validate()` + integrity. **Implementation must add an explicit assertion
that `validateBundle` uses the same `@trading-platform/sdk/validation` as the platform, not a parallel
copy of the logic** (this is the meaning of phase 042 — a single source). If the cross-check reveals
divergence, **fix it before signing — do not work around it.**

## 5. Testing

- **Unit** — `canonical` (golden vectors), `verdict` (threshold boundaries), `signing` (sign→verify
  roundtrip), `artifact` (ref stability + serialization determinism).
- **Cross-repo conformance (load-bearing)** — build an artifact + `trustedSigners = { keyId: pubPem }`,
  call the **real** platform `verifySignedEvidence` (the actual function, **not a stub**) ⇒ `kind:'ok'`.
  Must cover edge-cases where byte-equal canonicalization could still diverge: `undefined` vs an absent
  key, empty array vs `null`. Negative: corrupt one byte of the body ⇒ `signature_invalid`; unknown
  keyId ⇒ `signature_invalid`.
- **Scope** — assert the evidence body scope feeds `scopeMatches` against a representative intake payload.

## 6. Outputs (handed to the platform)

- Signed evidence artifact (`{ body, signature }`, Ed25519), addressable by `artifactRef`.
- Bundle bytes, addressable by `bundleHash`.
- `keyId → publicKeyPem` for the platform `trustedSigners` allowlist.

## 7. Open coordination items (not blockers for Track B)

- Final `long_oi` bundle bytes from lab (signature serialization point) — re-run when delivered.
- Public-key exchange with the platform ops config (`trustedSigners`) — can start now.
- Intake-payload scope mirroring (lab/platform builds the candidate scope to match this evidence).
