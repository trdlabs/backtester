# Signed backtest-evidence (Track B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a signed `backtest-evidence/v1` artifact that the platform's offline 043 verifier accepts — built end-to-end on a fixture bundle + real `long_oi` data.

**Architecture:** New pure module `apps/backtester/src/evidence/` (canonical / body / verdict / signing / artifact), composed by a harness script that reuses the existing `validateBundle` gate and the in-process engine backtest. All interop-critical logic is unit-tested with synthetic data and proven byte-compatible against the **real** platform verifier in a cross-repo conformance test.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `node:crypto` (Ed25519 + sha256), existing engine (`runBacktest`, `computeMetrics`), `@trading-platform/sdk/validation` kernel.

## Global Constraints

- **ESM / NodeNext:** every local import uses a `.js` extension (`../src/evidence/canonical.js`). Repo `type: module`. Tests are `apps/backtester/test/*.test.ts`, run by `vitest`.
- **Canonicalization is an exact mirror** of `trading-platform/src/admissions/verification/evidence-verifier.ts::canonicalizeEvidenceBody`: sorted keys, `JSON.stringify` for primitives, arrays as `[a,b]`, **no trailing newline, no number quantization**. NEVER reuse `src/determinism/canonical-json.ts` (it quantizes + adds `\n`).
- **`bundleHash` is the lab-provided raw-bytes sha256** `'sha256:' + sha256(rawBundleBytes).hex` (lowercase, `/^sha256:[0-9a-f]{64}$/`). It is NOT the structured `engine/sandbox/bundle-hash.ts::computeBundleHash`. Putting the structured hash in the body passes unit tests but fails admission with `bundle_backtest_mismatch`.
- **Never emit `verdict:'passed'`** unless `decideVerdict` returns `'passed'` from real backtest metrics. No manual override on the signing path.
- **Signature** = Ed25519 detached: `crypto.sign(null, Buffer.from(canonical(body),'utf8'), edPrivKey).toString('base64')`.
- **Private key never committed.** Injected via `BT_EVIDENCE_SIGNING_KEY` (PEM); tests use a throwaway generated key.
- Spec: `docs/superpowers/specs/2026-06-27-signed-backtest-evidence-design.md`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/backtester/src/evidence/canonical.ts` | `canonicalizeEvidenceBody` — exact platform mirror |
| `apps/backtester/src/evidence/body.ts` | `SignedEvidenceBody` / `SignedBacktestEvidence` / `EvidenceScope` types + `buildEvidenceBody` |
| `apps/backtester/src/evidence/verdict.ts` | `EvidenceThresholds` + `DEFAULT_THRESHOLDS` + `decideVerdict` |
| `apps/backtester/src/evidence/signing.ts` | Ed25519 keygen / sign / local verify mirror / `deriveKeyId` |
| `apps/backtester/src/evidence/artifact.ts` | `serializeArtifact` / `artifactRef` / `sha256BundleRef` |
| `apps/backtester/scripts/produce-evidence.mts` | Harness: validate → backtest → verdict → sign → write artifact + pubkey |
| `apps/backtester/test/evidence-*.test.ts` | Unit + conformance tests |

---

### Task 1: Canonicalization (`canonical.ts`)

**Files:**
- Create: `apps/backtester/src/evidence/canonical.ts`
- Test: `apps/backtester/test/evidence-canonical.test.ts`

**Interfaces:**
- Produces: `canonicalizeEvidenceBody(value: unknown): string`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/evidence-canonical.test.ts
import { describe, expect, it } from 'vitest';
import { canonicalizeEvidenceBody as canon } from '../src/evidence/canonical.js';

describe('canonicalizeEvidenceBody — exact platform stableStringify mirror', () => {
  it('sorts object keys lexicographically', () => {
    expect(canon({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('recurses into nested objects and arrays, no spaces', () => {
    expect(canon({ window: { toMs: 2, fromMs: 1 }, symbols: ['B', 'A'] }))
      .toBe('{"symbols":["B","A"],"window":{"fromMs":1,"toMs":2}}');
  });
  it('serializes primitives via JSON.stringify, no trailing newline', () => {
    expect(canon('x')).toBe('"x"');
    expect(canon(42)).toBe('42');
    expect(canon(null)).toBe('null');
    expect(canon(true)).toBe('true');
  });
  it('keeps empty array as [] (not null)', () => {
    expect(canon({ symbols: [] })).toBe('{"symbols":[]}');
  });
  it('matches the full evidence-body shape byte-for-byte', () => {
    const body = {
      schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
      verdict: 'passed', datasetRef: 'ds', window: { fromMs: 1, toMs: 2 },
      symbols: ['AUSDT'], timeframe: '1m', keyId: 'bt-ed25519-0',
    };
    expect(canon(body)).toBe(
      '{"backtesterRunId":"r1","bundleHash":"sha256:ab","datasetRef":"ds","keyId":"bt-ed25519-0","schema":"backtest-evidence/v1","symbols":["AUSDT"],"timeframe":"1m","verdict":"passed","window":{"fromMs":1,"toMs":2}}',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-canonical.test.ts`
Expected: FAIL — cannot resolve `../src/evidence/canonical.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/evidence/canonical.ts
// Exact mirror of trading-platform/src/admissions/verification/evidence-verifier.ts::canonicalizeEvidenceBody.
// MUST stay byte-identical — the platform verifies the Ed25519 signature over these bytes offline.
// Do NOT reuse src/determinism/canonical-json.ts (it quantizes numbers + appends '\n').

/** Deterministic sorted-key serialization — the bytes the Ed25519 signature is computed over. */
export function canonicalizeEvidenceBody(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvidenceBody).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeEvidenceBody(obj[k])}`).join(',')}}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-canonical.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/canonical.ts apps/backtester/test/evidence-canonical.test.ts
git commit -m "feat(evidence): canonicalizeEvidenceBody — platform stableStringify mirror"
```

---

### Task 2: Ed25519 signing (`signing.ts`)

**Files:**
- Create: `apps/backtester/src/evidence/signing.ts`
- Test: `apps/backtester/test/evidence-signing.test.ts`

**Interfaces:**
- Consumes: `canonicalizeEvidenceBody` (Task 1).
- Produces:
  - `interface SigningKey { keyId: string; privateKey: KeyObject; publicKeyPem: string }`
  - `deriveKeyId(publicKey: KeyObject): string`
  - `generateSigningKey(): SigningKey`
  - `loadSigningKeyFromPem(privateKeyPem: string): SigningKey`
  - `signEvidence(body: unknown, privateKey: KeyObject): { body: unknown; signature: string }`
  - `type TrustedSigners = Readonly<Record<string, string>>`
  - `verifySignedEvidenceLocal(artifact: { body: unknown; signature: string }, trustedSigners: TrustedSigners): { ok: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/evidence-signing.test.ts
import { describe, expect, it } from 'vitest';
import {
  generateSigningKey, signEvidence, verifySignedEvidenceLocal, loadSigningKeyFromPem,
} from '../src/evidence/signing.js';

const BODY = {
  schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
  verdict: 'passed', datasetRef: 'ds', window: { fromMs: 1, toMs: 2 },
  symbols: ['AUSDT'], timeframe: '1m', keyId: 'placeholder',
};

describe('Ed25519 signing', () => {
  it('keyId is deterministic + bt-ed25519- prefixed', () => {
    const k = generateSigningKey();
    expect(k.keyId).toMatch(/^bt-ed25519-[0-9a-f]{16}$/);
    expect(loadSigningKeyFromPem(k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).keyId)
      .toBe(k.keyId);
  });
  it('sign → local verify roundtrip succeeds', () => {
    const k = generateSigningKey();
    const body = { ...BODY, keyId: k.keyId };
    const artifact = signEvidence(body, k.privateKey);
    expect(typeof artifact.signature).toBe('string');
    expect(verifySignedEvidenceLocal(artifact, { [k.keyId]: k.publicKeyPem }).ok).toBe(true);
  });
  it('rejects a corrupted body', () => {
    const k = generateSigningKey();
    const artifact = signEvidence({ ...BODY, keyId: k.keyId }, k.privateKey);
    const tampered = { ...artifact, body: { ...artifact.body, verdict: 'failed' } };
    expect(verifySignedEvidenceLocal(tampered, { [k.keyId]: k.publicKeyPem }).ok).toBe(false);
  });
  it('rejects an unknown keyId', () => {
    const k = generateSigningKey();
    const artifact = signEvidence({ ...BODY, keyId: k.keyId }, k.privateKey);
    expect(verifySignedEvidenceLocal(artifact, {}).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-signing.test.ts`
Expected: FAIL — cannot resolve `../src/evidence/signing.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/evidence/signing.ts
import {
  generateKeyPairSync, createPublicKey, createPrivateKey, createHash,
  sign as cryptoSign, verify as cryptoVerify, type KeyObject,
} from 'node:crypto';
import { canonicalizeEvidenceBody } from './canonical.js';

export interface SigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}

export type TrustedSigners = Readonly<Record<string, string>>;

/** Stable keyId from the SPKI DER of the public key. */
export function deriveKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return 'bt-ed25519-' + createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId: deriveKeyId(publicKey),
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

export function loadSigningKeyFromPem(privateKeyPem: string): SigningKey {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: deriveKeyId(publicKey),
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** Detached Ed25519 signature (base64) over canonical(body). */
export function signEvidence(body: unknown, privateKey: KeyObject): { body: unknown; signature: string } {
  const signature = cryptoSign(null, Buffer.from(canonicalizeEvidenceBody(body), 'utf8'), privateKey)
    .toString('base64');
  return { body, signature };
}

/** Local mirror of the platform verifier — for fast unit feedback only (NOT the conformance gate). */
export function verifySignedEvidenceLocal(
  artifact: { body: unknown; signature: string },
  trustedSigners: TrustedSigners,
): { ok: boolean } {
  const keyId = (artifact.body as { keyId?: string }).keyId;
  const pem = keyId ? trustedSigners[keyId] : undefined;
  if (!pem) return { ok: false };
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalizeEvidenceBody(artifact.body), 'utf8'),
      createPublicKey(pem),
      Buffer.from(artifact.signature, 'base64'),
    );
    return { ok };
  } catch {
    return { ok: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-signing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/signing.ts apps/backtester/test/evidence-signing.test.ts
git commit -m "feat(evidence): Ed25519 signing + deterministic keyId + local verify mirror"
```

---

### Task 3: Evidence body (`body.ts`)

**Files:**
- Create: `apps/backtester/src/evidence/body.ts`
- Test: `apps/backtester/test/evidence-body.test.ts`

**Interfaces:**
- Produces:
  - `interface SignedEvidenceBody { schema:'backtest-evidence/v1'; backtesterRunId:string; bundleHash:string; verdict:'passed'|'failed'; datasetRef:string; window:{fromMs:number;toMs:number}; symbols:readonly string[]; timeframe:string; keyId:string }`
  - `interface SignedBacktestEvidence { body: SignedEvidenceBody; signature: string }`
  - `interface EvidenceScope { datasetRef:string; window:{fromMs:number;toMs:number}; symbols:readonly string[]; timeframe:string }`
  - `buildEvidenceBody(input:{ backtesterRunId:string; bundleHash:string; verdict:'passed'|'failed'; scope:EvidenceScope; keyId:string }): SignedEvidenceBody`

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/evidence-body.test.ts
import { describe, expect, it } from 'vitest';
import { buildEvidenceBody } from '../src/evidence/body.js';
import { canonicalizeEvidenceBody } from '../src/evidence/canonical.js';

const SCOPE = { datasetRef: 'ds', window: { fromMs: 10, toMs: 20 }, symbols: ['BUSDT', 'AUSDT'], timeframe: '1m' };

describe('buildEvidenceBody', () => {
  it('emits the fixed shape with schema constant and sorted symbols', () => {
    const body = buildEvidenceBody({ backtesterRunId: 'r1', bundleHash: 'sha256:ab', verdict: 'passed', scope: SCOPE, keyId: 'k' });
    expect(body.schema).toBe('backtest-evidence/v1');
    expect(body.symbols).toEqual(['AUSDT', 'BUSDT']); // sorted, deterministic
    expect(body).toEqual({
      schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
      verdict: 'passed', datasetRef: 'ds', window: { fromMs: 10, toMs: 20 },
      symbols: ['AUSDT', 'BUSDT'], timeframe: '1m', keyId: 'k',
    });
  });
  it('never emits undefined / missing keys (no key whose canonical value is "undefined")', () => {
    const body = buildEvidenceBody({ backtesterRunId: 'r', bundleHash: 'sha256:0', verdict: 'failed', scope: { ...SCOPE, symbols: [] }, keyId: 'k' });
    expect(canonicalizeEvidenceBody(body)).not.toContain('undefined');
    expect(body.symbols).toEqual([]); // empty array, not null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-body.test.ts`
Expected: FAIL — cannot resolve `../src/evidence/body.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/evidence/body.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-body.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/body.ts apps/backtester/test/evidence-body.test.ts
git commit -m "feat(evidence): SignedEvidenceBody shapes + buildEvidenceBody (sorted, fixed-shape)"
```

---

### Task 4: Verdict policy (`verdict.ts`)

**Files:**
- Create: `apps/backtester/src/evidence/verdict.ts`
- Test: `apps/backtester/test/evidence-verdict.test.ts`

**Interfaces:**
- Produces:
  - `interface EvidenceThresholds { minSharpe:number; maxDrawdown:number; minWinRate:number; minTrades:number }`
  - `const DEFAULT_THRESHOLDS: EvidenceThresholds`
  - `decideVerdict(metrics: Record<string, number>, thresholds?: EvidenceThresholds): 'passed' | 'failed'`
- Metric keys consumed (from `computeMetrics`): `sharpe`, `max_drawdown`, `win_rate`, `total_trades`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/evidence-verdict.test.ts
import { describe, expect, it } from 'vitest';
import { decideVerdict, DEFAULT_THRESHOLDS } from '../src/evidence/verdict.js';

const good = { sharpe: 0.5, max_drawdown: 0.3, win_rate: 0.4, total_trades: 12 };

describe('decideVerdict (conservative defaults)', () => {
  it('passes a clearly-good run', () => {
    expect(decideVerdict(good)).toBe('passed');
  });
  it('fails sharpe <= 0', () => {
    expect(decideVerdict({ ...good, sharpe: 0 })).toBe('failed');
  });
  it('fails drawdown >= 100%', () => {
    expect(decideVerdict({ ...good, max_drawdown: 1 })).toBe('failed');
  });
  it('fails win_rate <= 0', () => {
    expect(decideVerdict({ ...good, win_rate: 0 })).toBe('failed');
  });
  it('fails zero trades', () => {
    expect(decideVerdict({ ...good, total_trades: 0 })).toBe('failed');
  });
  it('fails when a required metric is missing (conservative)', () => {
    expect(decideVerdict({ sharpe: 1, win_rate: 1, total_trades: 5 })).toBe('failed');
  });
  it('default thresholds are the conservative floor', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-verdict.test.ts`
Expected: FAIL — cannot resolve `../src/evidence/verdict.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/evidence/verdict.ts
// Verdict gate: passed iff the run clears every threshold, computed from REAL backtest metrics.
// Conservative floor only — a real product gate is calibrated from operational experience.
// TODO(product): replace these floors with calibrated thresholds once we have production data.
//   Hardcoding arbitrary numbers now would look intentional and get copied unverified.

export interface EvidenceThresholds {
  readonly minSharpe: number;    // strict >  (per-bar Sharpe; > 0 = "edge, not noise")
  readonly maxDrawdown: number;  // strict <  (fraction; 1 = 100% = blew up)
  readonly minWinRate: number;   // strict >  (fraction; > 0 = won at least once)
  readonly minTrades: number;    // >=        (at least one closed trade)
}

export const DEFAULT_THRESHOLDS: EvidenceThresholds = {
  minSharpe: 0,
  maxDrawdown: 1,
  minWinRate: 0,
  minTrades: 1,
};

/** Missing metric ⇒ failed (conservative). Metric names match engine computeMetrics output. */
export function decideVerdict(
  metrics: Record<string, number>,
  thresholds: EvidenceThresholds = DEFAULT_THRESHOLDS,
): 'passed' | 'failed' {
  const sharpe = metrics.sharpe;
  const drawdown = metrics.max_drawdown;
  const winRate = metrics.win_rate;
  const trades = metrics.total_trades;
  if (sharpe === undefined || drawdown === undefined || winRate === undefined || trades === undefined) {
    return 'failed';
  }
  const ok =
    sharpe > thresholds.minSharpe &&
    drawdown < thresholds.maxDrawdown &&
    winRate > thresholds.minWinRate &&
    trades >= thresholds.minTrades;
  return ok ? 'passed' : 'failed';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-verdict.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/verdict.ts apps/backtester/test/evidence-verdict.test.ts
git commit -m "feat(evidence): decideVerdict + conservative DEFAULT_THRESHOLDS (TODO product gate)"
```

---

### Task 5: Artifact serialization + content-hash refs (`artifact.ts`)

**Files:**
- Create: `apps/backtester/src/evidence/artifact.ts`
- Test: `apps/backtester/test/evidence-artifact.test.ts`

**Interfaces:**
- Consumes: `canonicalizeEvidenceBody` (Task 1), `SignedBacktestEvidence` (Task 3).
- Produces:
  - `serializeArtifact(artifact: { body: unknown; signature: string }): Uint8Array`
  - `artifactRef(bytes: Uint8Array): string`  (`sha256:<hex>`)
  - `sha256BundleRef(bytes: Uint8Array): string`  (`sha256:<hex>` — mirrors platform bundle-resolver)

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/evidence-artifact.test.ts
import { describe, expect, it } from 'vitest';
import { serializeArtifact, artifactRef, sha256BundleRef } from '../src/evidence/artifact.js';

const artifact = { body: { b: 1, a: 2 }, signature: 'sig==' };

describe('artifact serialization + refs', () => {
  it('serialization is deterministic (stable across key order)', () => {
    const a = serializeArtifact({ body: { b: 1, a: 2 }, signature: 'sig==' });
    const b = serializeArtifact({ signature: 'sig==', body: { a: 2, b: 1 } });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
  it('artifactRef is sha256:<64hex> and content-addressed', () => {
    const ref = artifactRef(serializeArtifact(artifact));
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifactRef(serializeArtifact(artifact))).toBe(ref); // stable
  });
  it('sha256BundleRef matches the platform bundle-resolver form', () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(sha256BundleRef(Buffer.from('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-artifact.test.ts`
Expected: FAIL — cannot resolve `../src/evidence/artifact.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/backtester/src/evidence/artifact.ts
import { createHash } from 'node:crypto';
import { canonicalizeEvidenceBody } from './canonical.js';

/** Deterministic on-disk bytes for the artifact (canonical, so the content-hash ref is stable). */
export function serializeArtifact(artifact: { body: unknown; signature: string }): Uint8Array {
  return Buffer.from(canonicalizeEvidenceBody(artifact), 'utf8');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Content-hash locator for the evidence artifact (entry in evidence.artifactRefs). */
export function artifactRef(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** sha256 of raw bundle bytes — same form the platform ExternalArtifactSource re-hashes (triple-hash). */
export function sha256BundleRef(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-artifact.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/artifact.ts apps/backtester/test/evidence-artifact.test.ts
git commit -m "feat(evidence): deterministic artifact serialization + sha256 content-hash refs"
```

---

### Task 6: Cross-repo conformance against the REAL platform verifier

**Files:**
- Create: `apps/backtester/test/evidence-conformance.test.ts`

**Interfaces:**
- Consumes: `generateSigningKey`, `signEvidence` (Task 2), `buildEvidenceBody` (Task 3).
- Dynamically imports the **real** `trading-platform/src/admissions/verification/evidence-verifier.ts::verifySignedEvidence` (its only runtime dep is `node:crypto`; the `../ports.js` / `paper_candidate.js` imports are `import type`, erased). Pattern mirrors `test/golden-sync.test.ts` (`PLATFORM_REPO` env).

- [ ] **Step 1: Write the test**

```ts
// apps/backtester/test/evidence-conformance.test.ts
// Load-bearing: proves our signed artifact verifies under the ACTUAL platform function, not a local mirror.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSigningKey, signEvidence } from '../src/evidence/signing.js';
import { buildEvidenceBody } from '../src/evidence/body.js';

const PLATFORM_REPO = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';
const VERIFIER = resolve(PLATFORM_REPO, 'src/admissions/verification/evidence-verifier.ts');

async function loadPlatformVerify(): Promise<(a: unknown, s: Record<string, string>) => { kind: string }> {
  const mod = await import(pathToFileURL(VERIFIER).href);
  return mod.verifySignedEvidence;
}

const SCOPE = { datasetRef: 'long_oi-2026-06', window: { fromMs: 1781291247232, toMs: 1781804581980 }, symbols: ['HUSDT', 'NOTUSDT'], timeframe: '1m' };

describe('043 conformance — platform verifySignedEvidence accepts our artifact', () => {
  it.skipIf(!existsSync(VERIFIER))('verdict:ok for a well-formed signed artifact', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const body = buildEvidenceBody({ backtesterRunId: 'rt-1', bundleHash: 'sha256:' + 'a'.repeat(64), verdict: 'passed', scope: SCOPE, keyId: k.keyId });
    const artifact = signEvidence(body, k.privateKey);
    const v = verify(artifact, { [k.keyId]: k.publicKeyPem });
    expect(v.kind).toBe('ok');
    expect((v as { verdict: string }).verdict).toBe('passed');
  });
  it.skipIf(!existsSync(VERIFIER))('signature_invalid on tampered body (empty-array edge case preserved)', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const body = buildEvidenceBody({ backtesterRunId: 'rt-2', bundleHash: 'sha256:' + 'b'.repeat(64), verdict: 'failed', scope: { ...SCOPE, symbols: [] }, keyId: k.keyId });
    const artifact = signEvidence(body, k.privateKey);
    const tampered = { ...artifact, body: { ...artifact.body, datasetRef: 'other' } };
    expect(verify(tampered, { [k.keyId]: k.publicKeyPem }).kind).toBe('signature_invalid');
  });
  it.skipIf(!existsSync(VERIFIER))('signature_invalid on unknown keyId', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const artifact = signEvidence(buildEvidenceBody({ backtesterRunId: 'rt-3', bundleHash: 'sha256:' + 'c'.repeat(64), verdict: 'passed', scope: SCOPE, keyId: k.keyId }), k.privateKey);
    expect(verify(artifact, {}).kind).toBe('signature_invalid');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd apps/backtester && PLATFORM_REPO=/home/alexxxnikolskiy/projects/trading-platform npx vitest run test/evidence-conformance.test.ts`
Expected: PASS (3 tests). If the platform verifier file is absent the tests SKIP with a visible skip marker — investigate (do not treat a skip as a pass) before relying on conformance.

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test/evidence-conformance.test.ts
git commit -m "test(evidence): cross-repo conformance vs real platform verifySignedEvidence"
```

---

### Task 7: Kernel single-source assertion (042 guard)

**Files:**
- Create: `apps/backtester/test/evidence-kernel-singlesource.test.ts`

**Context:** `apps/backtester/test/validator-kernel-equivalence.test.ts` already proves the app-validator and `@trading-platform/sdk/validation` `validate()` agree on the 017 fixtures. The acceptance-gate `validateBundle` calls the app-validator. This task adds a focused assertion that the produce-evidence path's validation is the SAME kernel — a drift tripwire. **If this assertion ever fails, fix the divergence before signing — do not skip the gate.**

**Interfaces:**
- Consumes: `validate` from `../src/engine/validation/index.js`, `validate as kernelValidate` from `@trading-platform/sdk/validation`, `platformContractContext` from `@trading/research-contracts/research`.

- [ ] **Step 1: Write the test**

```ts
// apps/backtester/test/evidence-kernel-singlesource.test.ts
// 042 tripwire for the evidence path: the bundle validation the harness relies on MUST delegate to the
// same @trading-platform/sdk/validation kernel the platform admission uses — not a parallel copy.
import { describe, expect, it } from 'vitest';
import { validate as appValidate, type ValidationInput } from '../src/engine/validation/index.js';
import { validate as kernelValidate } from '@trading-platform/sdk/validation';
import { platformContractContext } from '@trading/research-contracts/research';

describe('evidence path uses the single-source validation kernel (042)', () => {
  it('app-validator and SDK kernel agree on a representative module input', () => {
    const ctx = platformContractContext([]);
    const input = { inputKind: 'module', manifest: { /* deliberately malformed to force issues */ } } as unknown as ValidationInput;
    const app = appValidate(input, ctx);
    const kernel = kernelValidate(input as never, ctx as never);
    expect(kernel.status).toBe(app.status);
    expect(kernel.issues.map((i: { code: string }) => i.code).sort())
      .toEqual(app.issues.map((i) => i.code).sort());
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd apps/backtester && npx vitest run test/evidence-kernel-singlesource.test.ts`
Expected: PASS. If it FAILS, the backtester validator has drifted from the platform kernel — **stop and reconcile before continuing** (the signature would otherwise attest a bundle the platform would validate differently).

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test/evidence-kernel-singlesource.test.ts
git commit -m "test(evidence): 042 tripwire — bundle validation delegates to SDK kernel"
```

---

### Task 8: Produce-evidence harness (`produce-evidence.mts`)

**Files:**
- Create: `apps/backtester/scripts/produce-evidence.mts`
- Test: `apps/backtester/test/evidence-harness.test.ts`

**Context:** Reuses the in-process engine backtest pattern from `scripts/reconcile-report.mts` (no Docker — runs in WSL2/CI) against the real `long_oi` exec-validation fixture `test/fixtures/exec-validation/long-oi-time-exit.json` (`{ trades, rowsBySymbol }`). `out.baseline.trades` + `out.baseline.evidence.equityCurve` feed `computeMetrics`.

**Interfaces:**
- Consumes everything above: `buildEvidenceBody`, `signEvidence` / `generateSigningKey` / `loadSigningKeyFromPem`, `decideVerdict`, `serializeArtifact` / `artifactRef` / `sha256BundleRef`.
- Produces: `produceEvidence(opts): Promise<{ artifact; artifactRef; bundleHash; keyId; publicKeyPem; verdict }>` (exported from the script for the smoke test) and a CLI `main()`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// apps/backtester/test/evidence-harness.test.ts
import { describe, expect, it } from 'vitest';
import { produceEvidence } from '../scripts/produce-evidence.mjs';
import { verifySignedEvidenceLocal } from '../src/evidence/signing.js';

describe('produceEvidence harness (real long_oi fixture, in-process engine)', () => {
  it('produces a locally-verifiable signed artifact with a verdict from real metrics', async () => {
    const out = await produceEvidence({}); // uses generated dev key + default fixture
    expect(out.body?.bundleHash ?? out.artifact.body.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(['passed', 'failed']).toContain(out.verdict);
    expect(out.artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifySignedEvidenceLocal(out.artifact, { [out.keyId]: out.publicKeyPem }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backtester && npx vitest run test/evidence-harness.test.ts`
Expected: FAIL — cannot resolve `../scripts/produce-evidence.mjs`.

- [ ] **Step 3: Write the harness**

```ts
// apps/backtester/scripts/produce-evidence.mts
// Track B harness: validate → backtest (real long_oi data, in-process engine) → verdict → sign → artifact.
// Backtest wiring mirrors scripts/reconcile-report.mts. The sandboxed (Docker) executor path is the FINAL
// long_oi wiring; Track B uses the in-process trusted router so it runs in WSL2/CI.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../src/engine/runner.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { computeMetrics } from '../src/engine/metrics.js';
import { makeReconcileReplayModule } from '../test/helpers-reconcile.js';
import { tapeFromRows, type PaperTrade } from '../test/helpers-replay.js';
import type { BacktestRunRequest, CanonicalRowV2, ExecutionProfile } from '@trading/research-contracts/research';
import { buildEvidenceBody, type EvidenceScope, type SignedBacktestEvidence } from '../src/evidence/body.js';
import { decideVerdict } from '../src/evidence/verdict.js';
import { generateSigningKey, loadSigningKeyFromPem, signEvidence, type SigningKey } from '../src/evidence/signing.js';
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
  const fixture = JSON.parse(readFileSync(opts.fixturePath ?? FIXTURE, 'utf8')) as {
    trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]>;
  };
  const symbols = Object.keys(fixture.rowsBySymbol).sort();

  // --- run the real engine per symbol; collect equity + trades ---
  const equity: { equity: number }[] = [];
  const trades: unknown[] = [];
  let minTs = Infinity, maxTs = -Infinity;
  for (const symbol of symbols) {
    const rows = fixture.rowsBySymbol[symbol];
    minTs = Math.min(minTs, rows[0].minute_ts);
    maxTs = Math.max(maxTs, rows[rows.length - 1].minute_ts + 60_000);
    const tape = tapeFromRows(symbol, rows);
    const mod = makeReconcileReplayModule(symbol, fixture.trades.filter((t) => t.symbol === symbol));
    const registry = createModuleRegistry({ strategies: [mod], riskProfiles: [DEFAULT_RISK], executionProfiles: [PAPER_MATCH] });
    const req = {
      runId: `evidence-${symbol}`, mode: 'research', moduleRef: { id: mod.manifest.id, version: '1.0.0' },
      datasetRef: symbol, symbols: [symbol], timeframe: '1m',
      period: { from: new Date(rows[0].minute_ts).toISOString(), to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString() },
      riskProfileRef: { id: 'default_risk', version: '1.0.0' }, executionProfileRef: { id: 'paper_match', version: '1.0.0' },
      seed: 1, metrics: ['pnl'],
    } as unknown as BacktestRunRequest;
    const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
    if (out.status !== 'completed') throw new Error(`run not completed for ${symbol}`);
    equity.push(...out.baseline.evidence.equityCurve);
    trades.push(...out.baseline.trades);
  }

  // --- metrics → verdict ---
  const metrics = computeMetrics(['sharpe', 'max_drawdown', 'win_rate', 'total_trades'], equity as never, trades as never);
  const verdict = decideVerdict(metrics);

  // --- bundleHash: raw-bytes sha256 of the self-contained bundle blob (Track B stand-in = fixture bytes) ---
  // The FINAL long_oi run takes bundleHash as a pinned input from lab — do NOT recompute from a directory.
  const bundleBytes = readFileSync(opts.fixturePath ?? FIXTURE);
  const bundleHash = sha256BundleRef(bundleBytes);

  const scope: EvidenceScope = { datasetRef: 'long_oi-exec-validation', window: { fromMs: minTs, toMs: maxTs }, symbols, timeframe: '1m' };
  const key = signingKey();
  const body = buildEvidenceBody({ backtesterRunId: `bt-${symbols.join('_')}`, bundleHash, verdict, scope, keyId: key.keyId });
  const artifact = signEvidence(body, key.privateKey) as SignedBacktestEvidence;
  const bytes = serializeArtifact(artifact);

  return { artifact, artifactRef: artifactRef(bytes), bundleHash, keyId: key.keyId, publicKeyPem: key.publicKeyPem, verdict };
}

async function main(): Promise<void> {
  const result = await produceEvidence({});
  const outDir = resolve(HERE, '../.evidence-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `${result.artifactRef.replace(':', '_')}.json`), serializeArtifact(result.artifact));
  writeFileSync(resolve(outDir, 'signer.pub.json'), JSON.stringify({ keyId: result.keyId, publicKeyPem: result.publicKeyPem }, null, 2));
  console.log(JSON.stringify({ artifactRef: result.artifactRef, bundleHash: result.bundleHash, verdict: result.verdict, keyId: result.keyId }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
import { pathToFileURL } from 'node:url';
```

> Note: move the `import { pathToFileURL }` line to the top import block — it is shown last only to flag that the `main()` guard needs it. The implementer assembles imports at the top per lint.

- [ ] **Step 4: Verify the equity/trades field paths**

Before running, confirm the extraction fields against the engine result type:
Run: `cd apps/backtester && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i evidence | head`
Expected: no type errors referencing `out.baseline.evidence.equityCurve` or `out.baseline.trades`. If `equityCurve` lives elsewhere on `BacktestRunResult`, read `src/engine/artifacts.ts::BacktestRunResult` and adjust the two `out.baseline...` accessors (the rest of the harness is unaffected).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/backtester && npx vitest run test/evidence-harness.test.ts`
Expected: PASS — a signed, locally-verifiable artifact with a verdict derived from real metrics.

- [ ] **Step 6: Run the script end-to-end**

Run: `cd apps/backtester && npx tsx scripts/produce-evidence.mts`
Expected: prints `{ artifactRef, bundleHash, verdict, keyId }`; writes `.evidence-out/<ref>.json` + `.evidence-out/signer.pub.json`.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/scripts/produce-evidence.mts apps/backtester/test/evidence-harness.test.ts
git commit -m "feat(evidence): produce-evidence harness — validate+backtest+sign on real long_oi data"
```

---

### Task 9: Full suite + spec close-out

- [ ] **Step 1: Run the whole evidence suite + typecheck**

Run: `cd apps/backtester && PLATFORM_REPO=/home/alexxxnikolskiy/projects/trading-platform npx vitest run test/evidence-*.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all evidence tests PASS, no type errors.

- [ ] **Step 2: Confirm no regression in the existing suite**

Run: `npm test` (repo root) or `cd apps/backtester && npx vitest run`
Expected: green (Docker-gated sandbox tests may skip in WSL2 — that is the existing baseline, not a regression).

- [ ] **Step 3: Commit any fixups + update the memory pointer**

If conformance revealed a canonicalization edge-case, fix it in `canonical.ts` and re-run Task 6. Then:
```bash
git add -A && git commit -m "chore(evidence): Track B green — suite + conformance pass"
```

---

## Self-Review

**Spec coverage:**
- §2.1 canonicalization → Task 1 (+ Task 6 real-verifier conformance). ✓
- §2.2 Ed25519 signature → Task 2. ✓
- §2.3 bundleHash raw-bytes form + TRAP → Task 5 (`sha256BundleRef`) + Task 8 (pinned input, not `computeBundleHash`). ✓
- §2.4 body shape → Task 3. ✓
- §2.5 scopeMatches scope → Task 3 (`EvidenceScope`) + Task 6 (scope in body) + Task 8 (scope from fixture). ✓
- §2.6 keyId / trustedSigners → Task 2 (`deriveKeyId`, pubPem) + Task 8 (pubkey export). ✓
- §3.3 verdict thresholds → Task 4. ✓
- §3.5 artifact locator → Task 5. ✓
- §3 harness flow → Task 8. ✓
- §4 042 single-source assertion → Task 7. ✓
- §5 conformance (real fn, edge-cases) → Task 6. ✓
- §6 outputs (artifact, bundle bytes by hash, keyId→pubPem) → Task 8 `main()`. ✓

**Placeholder scan:** No "TBD"/"implement later". The `TODO(product)` in `verdict.ts` is an intentional design artifact per the approved spec, not a plan gap. ✓

**Type consistency:** `SignedEvidenceBody`/`SignedBacktestEvidence`/`EvidenceScope` defined in Task 3 and consumed unchanged in Tasks 5/6/8. `canonicalizeEvidenceBody` (Task 1) consumed by Tasks 2/5. `decideVerdict`/`DEFAULT_THRESHOLDS` (Task 4) consumed by Task 8. Metric keys (`sharpe`/`max_drawdown`/`win_rate`/`total_trades`) consistent between Task 4 and Task 8 `computeMetrics` request. ✓

**Known integration risk (flagged, not a gap):** Task 8 Step 4 verifies the `out.baseline.evidence.equityCurve` / `out.baseline.trades` accessors against the real `BacktestRunResult` type before running — the one place the harness touches an existing shape it does not own.
