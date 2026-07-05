# Overlay-Run Registry Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `trading-lab` build valid overlay run requests by having the backtester publish its trusted registry (baselines/overlays/risk/exec + per-engine metric catalogs + named presets) via `GET /v1/registry`, shipped as `@trading-backtester/sdk@0.2.0`.

**Architecture:** A canonical `TRUSTED_REGISTRY_DEFINITION` becomes the single source for both `buildTrustedRegistry()` (resolution) and a new `/v1/registry` endpoint (discovery). The SDK gains `RegistryDescriptor`/`OverlayRunPreset` DTOs + a `discoverRegistry()` client method (bump to 0.2.0; the 017.2 run API is unchanged — additive only). `requestFingerprint` is fixed to include all run-affecting fields. The lab then selects a preset and submits a complete overlay request.

**Tech Stack:** TypeScript ESM, pnpm, Vitest, Fastify, tsup, Node `crypto`; the lab is Node-native-TS + Vitest, pnpm@9.

**Spec:** `docs/superpowers/specs/2026-06-19-overlay-registry-discovery-design.md`

**Repos / branches:**
- Phases 0–2 (release tooling, SDK 0.2.0, registry definition, endpoint, fingerprint): **`trading-backtester`**, branch `feat/overlay-registry-discovery` (already checked out).
- Phase 3 (lab adapter + e2e): **`trading-lab`**, in a NEW worktree+branch under `/home/alexxxnikolskiy/projects/trading-lab/.worktrees/` — the shared `trading-lab` checkout is used by another session; NEVER switch its branch.

---

## File map (trading-backtester)

```text
package.json                                              # sdk:verify → version-dynamic
scripts/verify-sdk-clean-consumer.ts                     # SDK_VERSION assertion → dynamic
packages/sdk/package.json                                # version → 0.2.0
packages/sdk/src/internal/versions.ts                    # SDK_VERSION → 0.2.0 (API_CONTRACT_VERSION stays)
packages/sdk/src/contracts/registry.ts                   # NEW: RegisteredModuleRef, OverlayRunPreset, RegistryDescriptor
packages/sdk/src/contracts/index.ts                      # export the registry types
packages/sdk/src/client/client.ts                        # discoverRegistry()
packages/sdk/test/registry-contract.test.ts              # NEW: pins the DTO shape
apps/backtester/src/engine/registry-definition.ts        # NEW: TRUSTED_REGISTRY_DEFINITION + validation
apps/backtester/src/engine/trusted-registry.ts           # refactor to build from the definition
apps/backtester/src/jobs/fingerprint.ts                  # shared normalize + complete fn + storedRequestFingerprint
apps/backtester/src/jobs/submit.ts                       # conflict guard recomputes stored fingerprint
apps/backtester/src/api/registry-route.ts                # NEW: GET /v1/registry handler
apps/backtester/src/api/server.ts                        # register the route
apps/backtester/test/sdk-client-registry.test.ts         # NEW: discoverRegistry() fake-fetchImpl unit test
apps/backtester/test/registry-endpoint.test.ts           # NEW
apps/backtester/test/trusted-registry-parity.test.ts     # NEW
apps/backtester/test/registry-definition.test.ts         # NEW
apps/backtester/test/fingerprint.test.ts                 # extend (field-completeness regression)
apps/backtester/test/idempotency.test.ts                 # extend (old-row replay + changed-field negative)
```

> **Cross-repo (trading-lab, Phase 3) files** are listed in Task 9 (a separate worktree under
> `trading-lab/.worktrees/`); they are not in this map, which covers the backtester repo only.

---

### Task 1: Make the SDK release tooling version-dynamic (Phase 0)

**Files:**
- Modify: `package.json` (`sdk:verify` script)
- Modify: `scripts/verify-sdk-clean-consumer.ts`

- [ ] **Step 1: Make `sdk:verify` resolve the version from packages/sdk/package.json**

In `package.json`, the `sdk:verify` script is currently:
```json
"sdk:verify": "tsx scripts/verify-sdk-package.ts .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz"
```
Change it to derive the version (POSIX `sh`, used by npm-script execution):
```json
"sdk:verify": "tsx scripts/verify-sdk-package.ts \".artifacts/sdk/trading-backtester-sdk-$(node -p \"require('./packages/sdk/package.json').version\").tgz\""
```

- [ ] **Step 2: Make the clean-consumer derive the expected version**

In `scripts/verify-sdk-clean-consumer.ts`, the smoke `smokeMjs` currently hardcodes
`if (SDK_VERSION !== '0.1.0') process.exit(1);`. Replace that literal check with one that reads the
expected version from the installed package's `package.json` at runtime. Change the smoke to:
```js
import { SDK_VERSION } from '@trading-backtester/sdk';
import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync(new URL('./node_modules/@trading-backtester/sdk/package.json', import.meta.url), 'utf8')).version;
if (SDK_VERSION !== expected) { console.error('SDK_VERSION', SDK_VERSION, '!== package.json', expected); process.exit(1); }
```
(Keep the rest of the smoke — `allSchemaAssets().length === 5`, builder/client/artifacts checks — unchanged.)

- [ ] **Step 3: Verify the 0.1.0 gates still pass**

```bash
pnpm sdk:build && pnpm sdk:pack && pnpm sdk:verify
pnpm exec tsx scripts/verify-sdk-clean-consumer.ts ".artifacts/sdk/trading-backtester-sdk-$(node -p "require('./packages/sdk/package.json').version").tgz"
```
Expected: exit 0 (still at 0.1.0 — proves the tooling works dynamically before the bump).

- [ ] **Step 4: Commit**
```bash
git add package.json scripts/verify-sdk-clean-consumer.ts
git commit -m "build(sdk): make release verify tooling version-dynamic"
```

---

### Task 2: SDK 0.2.0 registry contract DTOs (Phase 1)

**Files:**
- Create: `packages/sdk/src/contracts/registry.ts`
- Modify: `packages/sdk/src/contracts/index.ts`
- Modify: `packages/sdk/src/internal/versions.ts`
- Modify: `packages/sdk/package.json`
- Create: `packages/sdk/test/registry-contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

Create `packages/sdk/test/registry-contract.test.ts`:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SDK_VERSION, API_CONTRACT_VERSION } from '../src/contracts/index';
import type { RegistryDescriptor, OverlayRunPreset, RegisteredModuleRef, Ref } from '../src/contracts/index';

describe('registry discovery contract', () => {
  it('bumps the package SDK version but not the API contract version', () => {
    expect(SDK_VERSION).toBe('0.2.0');
    expect(API_CONTRACT_VERSION).toBe('017.2');
  });
  it('preset refs are pure Ref (no name/summary leak into the request)', () => {
    expectTypeOf<OverlayRunPreset['baselineRef']>().toEqualTypeOf<Ref>();
    expectTypeOf<OverlayRunPreset['riskProfileRef']>().toEqualTypeOf<Ref>();
    expectTypeOf<OverlayRunPreset['executionProfileRef']>().toEqualTypeOf<Ref>();
  });
  it('descriptor carries per-engine catalogs and presets', () => {
    expectTypeOf<RegistryDescriptor['metricCatalogs']['overlay']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<RegistryDescriptor['overlayRunPresets']>().toEqualTypeOf<readonly OverlayRunPreset[]>();
    expectTypeOf<RegistryDescriptor['baselines'][number]>().toEqualTypeOf<RegisteredModuleRef>();
  });
});
```
Run `pnpm vitest run packages/sdk/test/registry-contract.test.ts` → RED.

- [ ] **Step 2: Add the DTOs**

Create `packages/sdk/src/contracts/registry.ts`:
```ts
import type { Ref } from './run';

/** A registered module/profile, with optional display metadata (NOT sent in a run request). */
export interface RegisteredModuleRef {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly summary?: string;
}

/**
 * A complete, internally-consistent overlay-run recipe. Selected by `id`; the consumer applies its
 * own submitted overlay bundle on top of `baselineRef`. The refs are pure `Ref` (no name/summary)
 * so they drop straight into the run request without shifting its fingerprint.
 */
export interface OverlayRunPreset {
  readonly id: string;
  readonly name?: string;
  readonly baselineRef: Ref;
  readonly riskProfileRef: Ref;
  readonly executionProfileRef: Ref;
  readonly metrics: readonly string[];
}

export interface RegistryDescriptor {
  readonly contractVersion: string; // = API_CONTRACT_VERSION; the registry shape is additive
  readonly baselines: readonly RegisteredModuleRef[];
  readonly overlays: readonly RegisteredModuleRef[];
  readonly riskProfiles: readonly RegisteredModuleRef[];
  readonly execProfiles: readonly RegisteredModuleRef[];
  readonly metricCatalogs: {
    readonly momentum: readonly string[];
    readonly overlay: readonly string[];
  };
  readonly overlayRunPresets: readonly OverlayRunPreset[];
}
```

- [ ] **Step 3: Export them + bump the version**

In `packages/sdk/src/contracts/index.ts` add: `export type * from './registry';`

In `packages/sdk/src/internal/versions.ts` change ONLY:
```ts
export const SDK_VERSION = '0.2.0' as const;
```
(Leave `API_CONTRACT_VERSION = '017.2'` and all other constants unchanged.)

In `packages/sdk/package.json` change `"version": "0.1.0"` → `"version": "0.2.0"`.

- [ ] **Step 4: GREEN + build**
```bash
pnpm vitest run packages/sdk/test/registry-contract.test.ts packages/sdk/test/package-shape.test.ts
pnpm --filter @trading-backtester/sdk build
```
Expected: PASS (package-shape still green — version is asserted there too; update it if it pins 0.1.0 — change the `expect(pkg.version).toBe('0.1.0')` to `'0.2.0'`).

- [ ] **Step 5: Commit**
```bash
git add packages/sdk/src/contracts packages/sdk/src/internal/versions.ts packages/sdk/package.json packages/sdk/test
git commit -m "feat(sdk): add registry discovery contract (0.2.0)"
```

---

### Task 3: SDK client `discoverRegistry()`

> The SDK client is tested from `apps/backtester/test/` (importing the client from source —
> `../../../packages/sdk/src/client/index`). The existing `sdk-client.test.ts` is an HTTP-integration
> suite against a real app; this method is unit-tested in isolation with an injected `fetchImpl` so
> Task 3 is self-contained and does NOT depend on the `/v1/registry` endpoint (Task 6). The endpoint's
> real-app behavior is covered separately by Task 6.

**Files:**
- Modify: `packages/sdk/src/client/client.ts`
- Create: `apps/backtester/test/sdk-client-registry.test.ts`

- [ ] **Step 1: Write the failing fake-`fetchImpl` unit test (RED)**

`BacktesterClient` accepts `fetchImpl?: FetchLike` where `FetchLike = (url, init?) => Promise<FetchLikeResponse>`,
`init` is `{ method?, headers?: Record<string,string>, body? }`, and the response needs `{ ok, status, json(), text() }`.
The client sends `authorization: 'Bearer <token>'`. Create `apps/backtester/test/sdk-client-registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
import type { FetchLike, FetchLikeResponse } from '../../../packages/sdk/src/client/client';
import type { RegistryDescriptor } from '../../../packages/sdk/src/contracts/index';

describe('BacktesterClient.discoverRegistry', () => {
  it('GETs /v1/registry with bearer auth and returns the descriptor', async () => {
    const descriptor: RegistryDescriptor = {
      contractVersion: '017.2',
      baselines: [{ id: 'short_after_pump', version: '0.1.0' }],
      overlays: [], riskProfiles: [], execProfiles: [],
      metricCatalogs: { momentum: [], overlay: ['pnl'] },
      overlayRunPresets: [{
        id: 'default-overlay',
        baselineRef: { id: 'short_after_pump', version: '0.1.0' },
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
        executionProfileRef: { id: 'default_exec', version: '1.0.0' },
        metrics: ['pnl'],
      }],
    };
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, auth: init?.headers?.['authorization'] });
      return { ok: true, status: 200, json: async () => descriptor, text: async () => '' } satisfies FetchLikeResponse;
    };
    const client = new BacktesterClient({ baseUrl: 'http://bt.test', token: 'test-token', fetchImpl });
    const got = await client.discoverRegistry();
    expect(got).toEqual(descriptor);
    expect(calls.at(-1)?.url).toBe('http://bt.test/v1/registry');
    expect(calls.at(-1)?.method).toBe('GET');
    expect(calls.at(-1)?.auth).toBe('Bearer test-token');
  });
});
```
Run `pnpm vitest run apps/backtester/test/sdk-client-registry.test.ts` → RED (`discoverRegistry` is not a function).

- [ ] **Step 2: Add the method**

In `packages/sdk/src/client/client.ts` add an import of `RegistryDescriptor` from `../contracts/index` and a method that mirrors `getCapabilities` (returns the body directly — the endpoint returns the descriptor, not a wrapper):
```ts
discoverRegistry(): Promise<RegistryDescriptor> {
  return this.request('GET', '/v1/registry');
}
```

- [ ] **Step 3: GREEN + build + typecheck**
```bash
pnpm vitest run apps/backtester/test/sdk-client-registry.test.ts
pnpm --filter @trading-backtester/sdk build
pnpm typecheck
```
Expected: PASS, exit 0.

- [ ] **Step 4: Commit**
```bash
git add packages/sdk/src/client/client.ts apps/backtester/test/sdk-client-registry.test.ts
git commit -m "feat(sdk): add discoverRegistry() client method"
```

---

### Task 4: Canonical registry definition + refactor + validation

**Files:**
- Create: `apps/backtester/src/engine/registry-definition.ts`
- Modify: `apps/backtester/src/engine/trusted-registry.ts`
- Create: `apps/backtester/test/trusted-registry-parity.test.ts`
- Create: `apps/backtester/test/registry-definition.test.ts`

- [ ] **Step 1: Write the parity + validation tests (RED)**

`apps/backtester/test/trusted-registry-parity.test.ts` — assert the refactor changed no resolution:
```ts
import { describe, expect, it } from 'vitest';
import { buildTrustedRegistry } from '../src/engine/trusted-registry';

describe('buildTrustedRegistry parity', () => {
  it('resolves the same trusted refs after the definition refactor', () => {
    const r = buildTrustedRegistry();
    expect(r.resolveStrategy({ id: 'short_after_pump', version: '0.1.0' })).toBeDefined();
    expect(r.resolveOverlay({ id: 'early_exit_short_after_pump', version: '0.1.0' })).toBeDefined();
    expect(r.resolveRiskProfile({ id: 'default_risk', version: '1.0.0' })).toBeDefined();
    expect(r.resolveExecutionProfile({ id: 'default_exec', version: '1.0.0' })).toBeDefined();
    expect(r.resolveStrategy({ id: 'nope', version: '0.0.0' })).toBeUndefined();
  });
});
```

`apps/backtester/test/registry-definition.test.ts` — the fail-fast validator:
```ts
import { describe, expect, it } from 'vitest';
import { TRUSTED_REGISTRY_DEFINITION, validateRegistryDefinition } from '../src/engine/registry-definition';

describe('TRUSTED_REGISTRY_DEFINITION', () => {
  it('is self-consistent (unique preset ids, resolvable refs, overlay-catalog metrics)', () => {
    expect(() => validateRegistryDefinition(TRUSTED_REGISTRY_DEFINITION)).not.toThrow();
    expect(TRUSTED_REGISTRY_DEFINITION.overlayRunPresets.length).toBeGreaterThan(0);
  });
  it('rejects a dangling preset baseline ref', () => {
    const bad = { ...TRUSTED_REGISTRY_DEFINITION, overlayRunPresets: [
      { id: 'x', baselineRef: { id: 'ghost', version: '9.9.9' },
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
        executionProfileRef: { id: 'default_exec', version: '1.0.0' }, metrics: ['pnl'] },
    ] };
    expect(() => validateRegistryDefinition(bad)).toThrow(/ghost/);
  });
});
```
Run both → RED (module missing).

- [ ] **Step 2: Create the definition + validator**

Create `apps/backtester/src/engine/registry-definition.ts`. Use the existing module/profile objects and the overlay metric catalog. `METRIC_CATALOG` (momentum) is exported from `@trading/research-contracts`; the overlay catalog is `@trading/research-contracts/research`'s `METRIC_CATALOG` (imported elsewhere as `OVERLAY_METRIC_CATALOG`).
```ts
import { METRIC_CATALOG as MOMENTUM_METRIC_CATALOG } from '@trading/research-contracts';
import { METRIC_CATALOG as OVERLAY_METRIC_CATALOG } from '@trading/research-contracts/research';
import { DEFAULT_RISK, DEFAULT_EXEC } from './profiles.js';
import { shortAfterPump } from './examples/short-after-pump.strategy.js';
import { earlyExitShortAfterPump } from './examples/early-exit-short-after-pump.overlay.js';
import type {
  StrategyModule,
  HypothesisOverlayModule,
  RiskProfile,
  ExecutionProfile,
} from '@trading/research-contracts/research';

export interface OverlayRunPresetDef {
  readonly id: string;
  readonly name?: string;
  readonly baselineRef: { id: string; version: string };
  readonly riskProfileRef: { id: string; version: string };
  readonly executionProfileRef: { id: string; version: string };
  readonly metrics: readonly string[];
}

// Use the GENERAL contract types (matching `RegistryInput` in engine/registry.ts) so the definition
// accepts any registered module/profile, not just the current example concretes.
export interface RegistryDefinition {
  readonly strategies: readonly StrategyModule[];
  readonly overlays: readonly HypothesisOverlayModule[];
  readonly riskProfiles: readonly RiskProfile[];
  readonly executionProfiles: readonly ExecutionProfile[];
  readonly momentumMetricCatalog: readonly string[];
  readonly overlayMetricCatalog: readonly string[];
  readonly overlayRunPresets: readonly OverlayRunPresetDef[];
}

export const TRUSTED_REGISTRY_DEFINITION: RegistryDefinition = {
  strategies: [shortAfterPump],
  overlays: [earlyExitShortAfterPump],
  riskProfiles: [DEFAULT_RISK],
  executionProfiles: [DEFAULT_EXEC],
  momentumMetricCatalog: MOMENTUM_METRIC_CATALOG,
  overlayMetricCatalog: OVERLAY_METRIC_CATALOG,
  overlayRunPresets: [
    {
      id: 'default-overlay',
      name: 'Default overlay run (short_after_pump baseline)',
      baselineRef: { id: shortAfterPump.manifest.id, version: shortAfterPump.manifest.version },
      riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
      executionProfileRef: { id: DEFAULT_EXEC.id, version: DEFAULT_EXEC.version },
      // EXACT array — no `.filter()`. A metric not in the overlay catalog is a definition bug and
      // MUST make `validateRegistryDefinition` throw (fail-fast), not be silently dropped.
      metrics: ['pnl', 'max_drawdown', 'win_rate', 'sharpe'],
    },
  ],
};

/** Fail-fast: dup preset ids, dangling refs, empty/non-overlay-catalog metrics. */
export function validateRegistryDefinition(def: RegistryDefinition): void {
  const k = (r: { id: string; version: string }) => `${r.id}@${r.version}`;
  const strategies = new Set(def.strategies.map((s) => k(s.manifest)));
  const risks = new Set(def.riskProfiles.map(k));
  const execs = new Set(def.executionProfiles.map(k));
  const overlay = new Set(def.overlayMetricCatalog);
  const ids = new Set<string>();
  for (const p of def.overlayRunPresets) {
    if (ids.has(p.id)) throw new Error(`registry: duplicate preset id ${p.id}`);
    ids.add(p.id);
    if (!strategies.has(k(p.baselineRef))) throw new Error(`registry: preset ${p.id} baselineRef ${k(p.baselineRef)} not registered`);
    if (!risks.has(k(p.riskProfileRef))) throw new Error(`registry: preset ${p.id} riskProfileRef ${k(p.riskProfileRef)} not registered`);
    if (!execs.has(k(p.executionProfileRef))) throw new Error(`registry: preset ${p.id} executionProfileRef ${k(p.executionProfileRef)} not registered`);
    if (p.metrics.length === 0) throw new Error(`registry: preset ${p.id} has empty metrics`);
    for (const m of p.metrics) if (!overlay.has(m)) throw new Error(`registry: preset ${p.id} metric ${m} not in overlay catalog`);
  }
}

validateRegistryDefinition(TRUSTED_REGISTRY_DEFINITION);
```
Confirmed shapes (do NOT change these modules): `StrategyModule`/`HypothesisOverlayModule` carry `.manifest.id`/`.manifest.version`; `RiskProfile`/`ExecutionProfile` carry `.id`/`.version` directly. `DEFAULT_RISK = { id: 'default_risk', version: '1.0.0', … }`, `DEFAULT_EXEC = { id: 'default_exec', version: '1.0.0', … }`, `shortAfterPump.manifest = { id: 'short_after_pump', version: '0.1.0', … }`, `earlyExitShortAfterPump.manifest = { id: 'early_exit_short_after_pump', version: '0.1.0', … }`. The `validateRegistryDefinition(TRUSTED_REGISTRY_DEFINITION)` call at module load makes any drift fail at import time.

- [ ] **Step 3: Refactor `buildTrustedRegistry` to use the definition**

Rewrite `apps/backtester/src/engine/trusted-registry.ts`:
```ts
import { createTrustedRegistry, type TrustedModuleRegistry } from './registry.js';
import { TRUSTED_REGISTRY_DEFINITION } from './registry-definition.js';

/** The fixed trusted registry for the 6a overlay path, built from the canonical definition. */
export function buildTrustedRegistry(): TrustedModuleRegistry {
  return createTrustedRegistry({
    strategies: [...TRUSTED_REGISTRY_DEFINITION.strategies],
    overlays: [...TRUSTED_REGISTRY_DEFINITION.overlays],
    riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
    executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
  });
}
```

- [ ] **Step 4: GREEN + the overlay goldens stay green (resolution unchanged)**
```bash
pnpm vitest run apps/backtester/test/trusted-registry-parity.test.ts apps/backtester/test/registry-definition.test.ts apps/backtester/test/overlay-golden.test.ts
```
Expected: PASS; the overlay `result_hash` goldens are unchanged (the refactor is behavior-preserving).

- [ ] **Step 5: Commit**
```bash
git add apps/backtester/src/engine/registry-definition.ts apps/backtester/src/engine/trusted-registry.ts apps/backtester/test/trusted-registry-parity.test.ts apps/backtester/test/registry-definition.test.ts
git commit -m "refactor(engine): canonical TRUSTED_REGISTRY_DEFINITION + fail-fast validation"
```

---

### Task 5: Fix `requestFingerprint` completeness (with idempotency compatibility)

> **Compatibility context (read before implementing):** `requestFingerprint` is NOT the idempotency
> key — the dedup key is `resumeToken` (via `JobStore.insertOrGet`). The fingerprint is used ONLY in
> `submitRun`'s conflict guard (`submit.ts:151`): when a `resumeToken` resolves to an existing job and
> the fingerprints mismatch, it throws `409 resume_token_conflict`. Naively changing the algorithm
> would (a) make a legitimate replay of a **pre-deploy** job get a FALSE `409` (stored hash used an
> older algorithm), and — if "fixed" with a loose legacy-hash fallback — (b) silently ACCEPT a replay
> that changed a field the legacy hash ignored (e.g. `riskProfileRef`), which is a worse integrity bug.
>
> **Correct fix — recompute, don't store-compare.** The guard recomputes the STORED job's fingerprint
> with the CURRENT algorithm from `job.request` + `job.bundleHash`, and compares it to the incoming
> request's current fingerprint. This is exact: `bundleStore.put(bundle)` returns the same value as
> `bundleHash(bundle)` (`= contentRef(bundle)`), so the stored `job.bundleHash` reproduces the inline
> `bundleHash(moduleBundle)` the original submit hashed. Result: identical request → match (no false
> 409, regardless of which algorithm wrote the row); ANY changed run-affecting field → mismatch → real
> 409. No legacy hash function is needed, and the stored `job.requestFingerprint` field is no longer
> read by the guard. Changes no `result_hash` (the fingerprint is not part of the hashed `RunOutcome`).

**Files:**
- Modify: `apps/backtester/src/jobs/fingerprint.ts` (shared `normalize` + complete `requestFingerprint` + `storedRequestFingerprint`)
- Modify: `apps/backtester/src/jobs/submit.ts` (conflict guard recomputes the stored fingerprint)
- Modify: `apps/backtester/test/fingerprint.test.ts` (field-completeness regression)
- Modify: `apps/backtester/test/idempotency.test.ts` (replay-of-old-row positive + changed-field negative)

- [ ] **Step 1: Write failing field-completeness regression tests**

In `apps/backtester/test/fingerprint.test.ts` (read it first; it already tests `requestFingerprint`), add cases asserting DISTINCT fingerprints for requests differing ONLY in each newly-included field:
```ts
import { requestFingerprint } from '../src/jobs/fingerprint';
const base = {
  mode: 'research', moduleRef: { id: 'short_after_pump', version: '0.1.0' },
  datasetRef: 'BTCUSDT:1d', symbols: ['BTCUSDT'], timeframe: '1d',
  period: { from: '2024-06-07T00:00:00.000Z', to: '2024-06-13T00:00:00.000Z' }, seed: 42, metrics: ['pnl'],
} as const;
it('distinguishes engine', () => {
  expect(requestFingerprint({ ...base } as any)).not.toBe(requestFingerprint({ ...base, engine: 'overlay' } as any));
});
it('distinguishes overlayRefs', () => {
  expect(requestFingerprint({ ...base, engine: 'overlay' } as any))
    .not.toBe(requestFingerprint({ ...base, engine: 'overlay', overlayRefs: [{ id: 'o', version: '1.0.0' }] } as any));
});
it('distinguishes risk/exec/robustness', () => {
  const a = requestFingerprint({ ...base, engine: 'overlay' } as any);
  expect(a).not.toBe(requestFingerprint({ ...base, engine: 'overlay', riskProfileRef: { id: 'default_risk', version: '1.0.0' } } as any));
  expect(a).not.toBe(requestFingerprint({ ...base, engine: 'overlay', executionProfileRef: { id: 'default_exec', version: '1.0.0' } } as any));
  expect(a).not.toBe(requestFingerprint({ ...base, engine: 'overlay', robustnessChecks: ['walk_forward'] } as any));
});
```
Run → RED (current fingerprint omits these → equal).

- [ ] **Step 2: Extend `requestFingerprint` + add `storedRequestFingerprint` (shared `normalize`)**

Rewrite `apps/backtester/src/jobs/fingerprint.ts`. A single `normalize` builds the hashed object; the
bundle hash is passed in explicitly so a stored job (bundle bytes already replaced by a content hash)
recomputes byte-identically:
```ts
import type { RunSubmitRequest } from '@trading-backtester/sdk/contracts';
import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import { canonicalJson } from '../determinism/canonical-json';
import { sha256Hex } from '../determinism/hash';
import { bundleHash } from '../sandbox/bundle';

// ALL run-affecting fields. `bundleHashValue` = content hash of the submitted bundle (null for trusted
// runs), passed in so an incoming submit (bundle bytes present) and a stored job (bundle already a hash)
// produce the SAME object for the same request.
function normalize(req: RunSubmitRequest, bundleHashValue: ContentHash | null) {
  return {
    datasetRef: req.datasetRef,
    moduleRef: req.moduleRef,
    moduleBundle: bundleHashValue,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
    params: req.params ?? null,
    seed: req.seed,
    mode: req.mode,
    metrics: req.metrics ?? [],
    // run-affecting fields previously (incorrectly) omitted:
    engine: req.engine ?? null,
    overlayRefs: req.overlayRefs ?? [],
    riskProfileRef: req.riskProfileRef ?? null,
    executionProfileRef: req.executionProfileRef ?? null,
    robustnessChecks: req.robustnessChecks ?? [],
  };
}

/** Fingerprint of an INCOMING submit request (bundle bytes present → hashed inline). */
export function requestFingerprint(req: RunSubmitRequest): string {
  return sha256Hex(canonicalJson(normalize(req, req.moduleBundle ? bundleHash(req.moduleBundle) : null)));
}

/**
 * Fingerprint of an ALREADY-STORED job, recomputed with the CURRENT algorithm from its persisted
 * `request` + content-addressed bundle hash. Equals `requestFingerprint(originalBody)` exactly because
 * `bundleStore.put` returns the same `bundleHash` that the inline path hashes. The idempotency conflict
 * guard uses this so a `resumeToken` replay is judged identical iff EVERY run-affecting field matches —
 * independent of which algorithm version wrote the stored row.
 */
export function storedRequestFingerprint(req: RunSubmitRequest, bundleHashValue: ContentHash | null): string {
  return sha256Hex(canonicalJson(normalize(req, bundleHashValue)));
}
```

- [ ] **Step 3: GREEN on field-completeness**
```bash
pnpm vitest run apps/backtester/test/fingerprint.test.ts
```
Expected: the Step-1 regression cases PASS.

- [ ] **Step 4: Write the failing replay tests — positive (old row) AND negative (changed field)**

In `apps/backtester/test/idempotency.test.ts` (read it first to reuse its in-memory-store deps + valid
request builder), seed a job as if written by an OLDER algorithm (its stored `requestFingerprint` is a
placeholder the guard no longer reads), then exercise both replay directions:
```ts
import { storedRequestFingerprint, requestFingerprint } from '../src/jobs/fingerprint';

// `makeDeps` / the valid-request builder: mirror this file's existing helpers (in-memory store + clock + uid).
const overlayBody = { /* a valid overlay RunSubmitRequest: engine:'overlay', moduleRef, overlayRefs,
  riskProfileRef:{id:'default_risk',version:'1.0.0'}, executionProfileRef:{id:'default_exec',version:'1.0.0'},
  datasetRef, symbols, timeframe, period, seed, mode:'research', metrics:['pnl'] */ } as RunSubmitRequest;

async function seedOldRow(deps, runId, resumeToken, request) {
  await deps.store.insertOrGet({
    jobId: runId, runId, resumeToken,
    requestFingerprint: 'sha256:older-algorithm-row', // simulates a row written before this deploy
    request: { ...request, runId, metrics: request.metrics ?? [] },
    effectiveSeed: request.seed, datasetRef: request.datasetRef,
    queueDeadlineMs: 0, runTimeoutMs: 0, acceptedAtMs: 0,
  } as any);
}

it('replays a job stored by an older algorithm without a false conflict', async () => {
  const deps = makeDeps();
  const body = { ...overlayBody, resumeToken: 'rt-1' } as RunSubmitRequest;
  await seedOldRow(deps, 'run-1', 'rt-1', body);
  const outcome = await submitRun(deps, body); // identical request → idempotent replay, NO 409
  expect(outcome.created).toBe(false);
});

it('rejects a replay that changed a field the older hash ignored (e.g. riskProfileRef)', async () => {
  const deps = makeDeps();
  const stored = { ...overlayBody, resumeToken: 'rt-2', riskProfileRef: { id: 'default_risk', version: '1.0.0' } } as RunSubmitRequest;
  await seedOldRow(deps, 'run-2', 'rt-2', stored);
  const changed = { ...stored, riskProfileRef: { id: 'long_only_risk', version: '1.0.0' } };
  await expect(submitRun(deps, changed)).rejects.toMatchObject({ statusCode: 409, code: 'resume_token_conflict' });
  // sanity: the change is invisible to the old 10-field hash but visible to the current one
  expect(storedRequestFingerprint(stored, null)).not.toBe(requestFingerprint(changed));
});
```
Run → RED (the current guard compares the stored hash literally → the positive case throws a false 409).

- [ ] **Step 5: Recompute the stored fingerprint in the conflict guard**

In `apps/backtester/src/jobs/submit.ts`, import `storedRequestFingerprint` alongside `requestFingerprint`
and replace the literal comparison:
```ts
  const { job, created } = await deps.store.insertOrGet(newJob);
  if (!created) {
    if (storedRequestFingerprint(job.request, job.bundleHash ?? null) !== fingerprint) {
      throw new SubmitError(409, 'resume_token_conflict', 'resume token reused with a different request');
    }
    return { handle: toHandle(job, true), created: false };
  }
```
(`job.request` and `job.bundleHash` are on the returned `JobRow`. New jobs are still STORED with the
new `fingerprint`; the guard simply no longer trusts that stored value and recomputes from the request.)

- [ ] **Step 6: GREEN + confirm result goldens unaffected**
```bash
pnpm vitest run apps/backtester/test/fingerprint.test.ts apps/backtester/test/idempotency.test.ts apps/backtester/test/determinism.test.ts
```
Expected: all PASS (both replay directions); `result_hash` goldens UNCHANGED. If an idempotency test pins a LITERAL fingerprint value, update that literal (the fingerprint key changed by design); do NOT touch any `result_hash` golden.

- [ ] **Step 7: Commit**
```bash
git add apps/backtester/src/jobs/fingerprint.ts apps/backtester/src/jobs/submit.ts apps/backtester/test/fingerprint.test.ts apps/backtester/test/idempotency.test.ts
git commit -m "fix(jobs): complete request fingerprint; recompute stored fingerprint for replay integrity"
```

---

### Task 6: `GET /v1/registry` endpoint

**Files:**
- Create: `apps/backtester/src/api/registry-route.ts`
- Modify: `apps/backtester/src/api/server.ts`
- Create: `apps/backtester/test/registry-endpoint.test.ts`

- [ ] **Step 1: Write the failing endpoint test**

Read `apps/backtester/test/api.e2e.test.ts` for the in-process app + auth helper pattern. Create `apps/backtester/test/registry-endpoint.test.ts` that boots the app, GETs `/v1/registry` with the bearer token, and asserts the shape + the trusted refs + presets:
```ts
// (mirror api.e2e.test.ts's app setup + token)
it('GET /v1/registry returns the trusted registry + presets', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/registry', headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.baselines.map((b) => b.id)).toContain('short_after_pump');
  expect(body.overlays.map((o) => o.id)).toContain('early_exit_short_after_pump');
  expect(body.riskProfiles.map((p) => p.id)).toContain('default_risk');
  expect(body.execProfiles.map((p) => p.id)).toContain('default_exec');
  expect(body.metricCatalogs.overlay).toContain('pnl');
  expect(body.overlayRunPresets.length).toBeGreaterThan(0);
  const preset = body.overlayRunPresets[0];
  expect(preset.baselineRef).toEqual({ id: 'short_after_pump', version: '0.1.0' });
  expect(preset.baselineRef.name).toBeUndefined(); // pure Ref
});
it('rejects without a bearer token', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/registry' });
  expect(res.statusCode).toBe(401);
});
```
Run → RED (404).

- [ ] **Step 2: Build the descriptor + register the route**

Create `apps/backtester/src/api/registry-route.ts` that maps `TRUSTED_REGISTRY_DEFINITION` → a `RegistryDescriptor` (import the type from `@trading-backtester/sdk/contracts`):
```ts
import type { RegistryDescriptor } from '@trading-backtester/sdk/contracts';
import { API_CONTRACT_VERSION } from '@trading-backtester/sdk/contracts';
import { TRUSTED_REGISTRY_DEFINITION as D } from '../engine/registry-definition.js';

export function buildRegistryDescriptor(): RegistryDescriptor {
  const ref = (r: { id: string; version: string; name?: string; summary?: string }) =>
    ({ id: r.id, version: r.version, ...(r.name ? { name: r.name } : {}), ...(r.summary ? { summary: r.summary } : {}) });
  return {
    contractVersion: API_CONTRACT_VERSION,
    baselines: D.strategies.map((s) => ref(s.manifest)),
    overlays: D.overlays.map((o) => ref(o.manifest)),
    riskProfiles: D.riskProfiles.map((p) => ref(p)),
    execProfiles: D.executionProfiles.map((p) => ref(p)),
    metricCatalogs: { momentum: [...D.momentumMetricCatalog], overlay: [...D.overlayMetricCatalog] },
    overlayRunPresets: D.overlayRunPresets.map((p) => ({
      id: p.id, ...(p.name ? { name: p.name } : {}),
      baselineRef: { id: p.baselineRef.id, version: p.baselineRef.version },
      riskProfileRef: { id: p.riskProfileRef.id, version: p.riskProfileRef.version },
      executionProfileRef: { id: p.executionProfileRef.id, version: p.executionProfileRef.version },
      metrics: [...p.metrics],
    })),
  };
}
```
In `apps/backtester/src/api/server.ts`, register a bearer-authed `GET /v1/registry` next to the other routes (follow the exact auth + reply pattern used by `/v1/capabilities`), returning `buildRegistryDescriptor()`.

- [ ] **Step 3: GREEN + typecheck**
```bash
pnpm sdk:build   # the route imports the SDK dist type
pnpm vitest run apps/backtester/test/registry-endpoint.test.ts
pnpm typecheck
```
Expected: PASS, exit 0.

- [ ] **Step 4: Commit**
```bash
git add apps/backtester/src/api/registry-route.ts apps/backtester/src/api/server.ts apps/backtester/test/registry-endpoint.test.ts
git commit -m "feat(api): GET /v1/registry discovery endpoint"
```

---

### Task 7: Full backtester verification + package gates at 0.2.0

**Files:** Verify only.

- [ ] **Step 1: Full gates**
```bash
pnpm typecheck
pnpm test
pnpm sdk:build && pnpm sdk:pack && pnpm sdk:verify
pnpm exec tsx scripts/verify-sdk-clean-consumer.ts ".artifacts/sdk/trading-backtester-sdk-$(node -p "require('./packages/sdk/package.json').version").tgz"
```
Expected: typecheck 0; full suite green (new registry/fingerprint/parity tests pass; `result_hash` goldens unchanged); the packed tarball is `trading-backtester-sdk-0.2.0.tgz` and the clean-consumer passes against it.

- [ ] **Step 2: If a gate fails, return to its owning task, fix, re-run. No empty commit.**

---

### Task 8: Release readiness (Phase 2 — do NOT publish in this plan)

**Files:** Verify only.

- [ ] **Step 1: Confirm the release workflow is version-parameterized**

The `.github/workflows/sdk-release.yml` already takes a `version` input and checks `packages/sdk/package.json` version === input. Confirm it (and `sdk:verify`, now dynamic from Task 1) will work for `0.2.0`. Do NOT run `gh workflow run` — publishing `sdk-v0.2.0` is a separate, explicit, human-triggered step after this plan and after PR review.

- [ ] **Step 2: STOP.** Phases 0–1 are complete on `feat/overlay-registry-discovery`. Open the backtester PR only on request. Phase 3 (trading-lab) requires `sdk-v0.2.0` to be published first.

---

### Task 9: trading-lab — discriminated `target` + preset-driven `submitOverlayRun` + all adapters (Phase 3)

> **Single coherent task — committed ONCE, green.** Migrating the port's `SubmitOverlayRunOptions`
> breaks the typecheck of every `ResearchPlatformPort` implementor and every caller simultaneously.
> Do NOT commit a half-migrated tree (no "throws not implemented" stubs). Land the port change, all
> three adapters, and all call sites/tests in one working commit.
>
> **Per-adapter `target` support (deliberate):**
> - **HTTP (backtester)** — supports `registry_preset` ONLY. The backtester needs a COMPLETE request
>   (risk/exec/metrics), which only a preset supplies; a bare `baseline_ref` carries none of those, so
>   the HTTP adapter REJECTS `baseline_ref` with a clear validation error.
> - **MCP (platform)** — supports `baseline_ref` ONLY (its existing behavior); REJECTS `registry_preset`.
> - **Mock** — supports BOTH (its result is synthetic, independent of selection).

**Prerequisite:** `sdk-v0.2.0` must already be PUBLISHED (Task 8, human-gated) — Step 0 installs from its release tarball.

**Files (in the worktree):**
- Modify: `package.json` (re-pin `@trading-backtester/sdk` → 0.2.0 release URL) + `pnpm-lock.yaml`
- Modify: `src/ports/research-platform.port.ts` (`SubmitOverlayRunOptions`)
- Modify: `src/adapters/platform/http-backtester.adapter.ts` (+ its `BacktesterClientLike`)
- Modify: `src/adapters/platform/mock-research-platform.adapter.ts`
- Modify: `src/adapters/platform/mcp-research-platform.adapter.ts` (and any other `ResearchPlatformPort` impl)
- Modify: every call site + test surfaced in Step 1

- [ ] **Step 0: Create the worktree, re-pin the SDK to 0.2.0, install, commit the lockfile**

From the shared lab checkout's git — do NOT switch its branch:
```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git worktree add .worktrees/feat-overlay-presets -b feat/overlay-presets origin/main
cd .worktrees/feat-overlay-presets
```
In `package.json`, change the `@trading-backtester/sdk` dependency from the 0.1.0 release tarball to 0.2.0:
```
"@trading-backtester/sdk": "https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.2.0/trading-backtester-sdk-0.2.0.tgz"
```
Then install (this rewrites `pnpm-lock.yaml` to the new tarball + integrity) and commit BOTH:
```bash
pnpm install
git add package.json pnpm-lock.yaml
git commit -m "build: pin @trading-backtester/sdk to v0.2.0 release"
```
(If `pnpm install` fails to fetch the tarball, `sdk-v0.2.0` is not published yet — STOP and return to Task 8.)

- [ ] **Step 1: Enumerate ALL call sites and tests before changing the port**

```bash
grep -rn 'submitOverlayRun\|baselineModuleRef\|SubmitOverlayRunOptions' src test 2>/dev/null
```
Write the resulting list into the task notes — every production caller AND every test that constructs
`SubmitOverlayRunOptions` or calls `submitOverlayRun` must be migrated in this task. (Tests in this repo
are colocated under `src/`; a top-level `test/` may also exist — the `grep` covers both.) Do not proceed
until the list is complete (the port change will not typecheck until all of them are updated).

- [ ] **Step 2: Migrate the port options to a discriminated `target`**

In `src/ports/research-platform.port.ts`, replace the required `baselineModuleRef: Ref` on `SubmitOverlayRunOptions` with (keep the other option fields):
```ts
target:
  | { kind: 'registry_preset'; presetId?: string }
  | { kind: 'baseline_ref'; moduleRef: Ref };
```
`pnpm typecheck` is now RED across the implementors + call sites — that drives Steps 3–6.

- [ ] **Step 3: HTTP adapter — discovery + preset-driven submission (`registry_preset` only)**

In `http-backtester.adapter.ts`: add `discoverRegistry(): Promise<RegistryDescriptor>` to `BacktesterClientLike`
(import `RegistryDescriptor`/`OverlayRunPreset`/`Ref` from `@trading-backtester/sdk/contracts`); add a
memoized private `registry()` that calls `this.client.discoverRegistry()` once; add `resolvePreset`:
```ts
private async resolvePreset(presetId?: string): Promise<OverlayRunPreset> {
  const presets = (await this.registry()).overlayRunPresets;
  if (presetId) {
    const p = presets.find((x) => x.id === presetId);
    if (!p) throw new GatewayRunError({ category: 'validation_error', code: 'unknown_preset', message: `unknown overlay preset: ${presetId}` });
    return p;
  }
  if (presets.length === 1) return presets[0]!;
  throw new GatewayRunError({ category: 'validation_error', code: 'ambiguous_preset', message: `presetId required: ${presets.map((p) => p.id).join(', ')}` });
}
```
(Use the adapter's existing thrown error type — `GatewayRunError` or whatever `submitOverlayRun` already throws.)
In `submitOverlayRun(bundle, opts)`, switch on `opts.target.kind`:
- `'baseline_ref'` → **reject**: `throw new GatewayRunError({ category: 'validation_error', code: 'unsupported_target', message: 'the backtester integration requires a registry_preset target (baseline_ref is not supported)' })`.
- `'registry_preset'` → `const preset = await this.resolvePreset(opts.target.presetId)`; then build the request with `moduleRef = preset.baselineRef`, `riskProfileRef = preset.riskProfileRef`, `executionProfileRef = preset.executionProfileRef`, `metrics = [...preset.metrics]`, and `overlayRefs = [{ id: btBundle.manifest.id, version: btBundle.manifest.version }]` where `btBundle = toBacktesterBundle(bundle)`.

- [ ] **Step 4: Mock adapter — accept BOTH kinds**

In `mock-research-platform.adapter.ts`, the synthetic result is independent of selection — `switch` on
`opts.target.kind` and produce the same deterministic result for either kind (no network). Typechecks; existing tests pass.

- [ ] **Step 5: MCP adapter — `baseline_ref` only**

In `mcp-research-platform.adapter.ts`, map `{ kind: 'baseline_ref', moduleRef }` to its existing behavior
(the old `baselineModuleRef`); for `{ kind: 'registry_preset' }` throw a clear error: `presets are only supported on the backtester integration`.

- [ ] **Step 6: Update every enumerated call site + test**

For each entry from Step 1, replace `baselineModuleRef: ref` with the appropriate `target`:
- backtester/HTTP-path callers + the cross-repo e2e → `target: { kind: 'registry_preset' }` (single demo preset auto-selected; drop any hardcoded `baselineModuleRef: { id: 'baseline', version: 'v1' }`).
- platform/MCP-path callers → `target: { kind: 'baseline_ref', moduleRef: ref }`.
- mock-based unit tests → either kind, matching what each test asserts.
Add an HTTP-adapter unit test asserting `submitOverlayRun(bundle, { target: { kind: 'baseline_ref', moduleRef } })` throws `unsupported_target`, and one asserting a `registry_preset` submission issues a request carrying `overlayRefs`/`riskProfileRef`/`executionProfileRef`/non-empty `metrics` (use a fake `BacktesterClientLike` whose `discoverRegistry` returns a one-preset descriptor).

- [ ] **Step 7: Verify**
```bash
pnpm typecheck
pnpm test
```
Expected: typecheck 0; unit/adapter suites green (incl. the new HTTP-adapter target tests); the cross-repo e2e SKIPS without its env gate.

- [ ] **Step 8: Commit (single working commit)**

The SDK re-pin (`package.json` + `pnpm-lock.yaml`) was already committed in Step 0; this commit lands the
code + colocated/`test/` changes. Use `-A` so every migrated call site is staged regardless of directory:
```bash
git add -A
git commit -m "feat(platform): discriminated overlay-run target + preset-driven backtester submission"
```

---

### Task 10: Cross-repo acceptance (manual, demo stack)

**Files:** Verify only.

- [ ] **Step 1: Rebuild the demo backtester from the 0.2.0 branch + run the e2e**

With the demo stack rebuilt from the backtester branch (`TRADING_BACKTESTER_PATH` → the repo on `feat/overlay-registry-discovery` or merged main) and up:
```bash
RUN_CROSS_REPO_E2E=true BACKTESTER_API_URL=http://127.0.0.1:8081 BACKTESTER_API_TOKEN=demo-backtester-token \
  pnpm vitest run src/adapters/platform/cross-repo-e2e.integration.test.ts
```
Expected: the run reaches `completed` with a real overlay `comparison`. This is the definitive proof that lab→backtester overlay validation works end-to-end.

- [ ] **Step 2: Stop.** Do NOT open the lab PR or publish without a separate request.

---

## Spec coverage matrix

| Spec requirement | Task |
|---|---|
| Version-dynamic release tooling (Decision 9) | 1 |
| SDK 0.2.0 DTOs; SDK_VERSION→0.2.0, API stays 017.2 (Decisions 6) | 2 |
| `discoverRegistry()` client method (TDD fake-fetch test) | 3 |
| Canonical `TRUSTED_REGISTRY_DEFINITION` (general types) + parity + fail-fast validation (Decisions 7,8) | 4 |
| `requestFingerprint` completeness + legacy-hash idempotency compat (goldens unchanged) | 5 |
| `GET /v1/registry`; pure-Ref presets (Decision 1 fix) | 6 |
| No engine/validation/golden change; gates green | 4,5,7 |
| Publish `sdk-v0.2.0` (manual) | 8 |
| Discriminated `target`; per-adapter support; all call sites; preset-driven submission (single commit) | 9 |
| Cross-repo E2E `completed` + `comparison` | 10 |
