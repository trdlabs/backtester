# Public `@trading-backtester/sdk` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a complete standalone `@trading-backtester/sdk@0.1.0` with contracts, deterministic builder, HTTP client and artifact surfaces, ready to publish as a GitHub Release asset without breaking the current `trading-lab` path dependency.

**Architecture:** Add `packages/sdk` as the canonical public contract package. The backtester service migrates its external wire boundary and bundle hashing to SDK types, while engine-only and platform historical-data types remain in the private `@trading/research-contracts` package. The old `packages/client` stays frozen only until a separate `trading-lab` cutover, then is removed by the later cleanup phase.

**Tech Stack:** TypeScript 5.9, ESM, pnpm workspace, tsup, Vitest, Fastify HTTP integration tests, Node `crypto`, JSON Schema/Ajv, GitHub Actions and GitHub Release assets.

**Spec:** `docs/superpowers/specs/2026-06-19-public-backtester-sdk-design.md`

---

## Scope boundary

This plan implements **Phase 1** of the spec in `trading-backtester` only:

- creates the complete SDK;
- makes SDK contracts canonical at the service boundary;
- retains the existing client temporarily so `trading-lab/main` still installs;
- adds release automation but does not publish a release.

This plan does **not** edit `trading-lab`, delete `packages/client`, delete the
platform builder, publish `sdk-v0.1.0`, or move repositories into an
organization. Those actions require later approval and the separate consumer
cutover spec.

## File map

### New package

```text
packages/sdk/
├── LICENSE                              # Apache-2.0 package license
├── README.md                            # consumer install/API/boundary guide
├── package.json                         # public package metadata + subpath exports
├── tsconfig.json                        # package compilation config
├── tsup.config.ts                       # five ESM/d.ts entrypoints
├── schemas/                             # packaged validation schema assets
├── src/
│   ├── index.ts                         # identity/capability-only root
│   ├── internal/
│   │   ├── versions.ts                  # single source for SDK/contract versions
│   │   ├── shared-types.ts              # ContentHash (re-exported by contracts + artifacts)
│   │   ├── canonical-json.ts            # canonicalJson + quantizeContractNumber (decimal.js)
│   │   └── content-hash.ts              # sha256Hex / contentRef / canonicalBundleHash
│   ├── contracts/
│   │   ├── index.ts                     # curated contract facade
│   │   ├── versions.ts                  # SDK/API/bundle/artifact versions
│   │   ├── module.ts                    # bundle + executable ABI types
│   │   ├── run.ts                       # submit/lifecycle/result DTOs
│   │   ├── validation.ts                # reports/issues/error categories
│   │   └── capabilities.ts              # capabilities + dataset descriptors
│   ├── artifacts/
│   │   ├── index.ts                     # artifact facade
│   │   ├── types.ts                     # references/manifests/pages
│   │   └── guards.ts                    # pure content-hash guards
│   ├── builder/
│   │   ├── index.ts                     # deterministic authoring facade
│   │   ├── manifest.ts                  # manifest constructor
│   │   ├── bundle.ts                    # bundle constructor + canonical hash
│   │   └── preflight.ts                 # structural local validation
│   └── client/
│       ├── index.ts                     # client facade
│       ├── client.ts                    # fetch-based HTTP client
│       └── errors.ts                    # typed HTTP errors
└── test/
    ├── package-shape.test.ts
    ├── contracts.test.ts
    ├── artifacts.test.ts
    ├── builder.test.ts
    └── package-content.test.ts
```

### Repository integration

```text
apps/backtester/package.json
apps/backtester/src/api/server.ts
apps/backtester/src/engine/validation/schema-registry.ts
apps/backtester/src/artifacts/store.ts
apps/backtester/src/artifacts/overlay-store.ts
apps/backtester/src/determinism/canonical-json.ts
apps/backtester/src/determinism/hash.ts
apps/backtester/src/jobs/completion.ts
apps/backtester/src/jobs/fingerprint.ts
apps/backtester/src/jobs/submit.ts
apps/backtester/src/jobs/types.ts
apps/backtester/src/jobs/worker.ts
apps/backtester/src/sandbox/bundle.ts
apps/backtester/test/client-parity.test.ts
apps/backtester/test/client.test.ts
apps/backtester/test/sdk-client.test.ts
apps/backtester/test/contract-merge-guard.test.ts
package.json
pnpm-lock.yaml
vitest.config.ts
tsconfig.json
Dockerfile
.github/workflows/ci.yml
.github/workflows/sdk-release.yml
scripts/verify-sdk-package.ts
scripts/verify-sdk-clean-consumer.ts
scripts/sdk-release-manifest.ts
README.md
AGENTS.md
docs/ARCHITECTURE.md
```

---

### Task 1: Scaffold the public package and lock its export map

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/tsup.config.ts`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/src/internal/versions.ts`
- Create: `packages/sdk/src/internal/shared-types.ts`
- Create: `packages/sdk/src/contracts/index.ts`
- Create: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/src/client/index.ts`
- Create: `packages/sdk/src/artifacts/index.ts`
- Create: `packages/sdk/test/package-shape.test.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write a failing package-shape test**

Create `packages/sdk/test/package-shape.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  exports: Record<string, unknown>;
  files: string[];
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

describe('@trading-backtester/sdk package shape', () => {
  it('is public, licensed and exposes only the approved entrypoints', () => {
    expect(pkg.name).toBe('@trading-backtester/sdk');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe('Apache-2.0');
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './artifacts',
      './builder',
      './client',
      './contracts',
    ]);
    expect(pkg.files.sort()).toEqual(['LICENSE', 'README.md', 'dist', 'schemas']);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run packages/sdk/test/package-shape.test.ts
```

Expected: FAIL because `packages/sdk/package.json` does not exist.

- [ ] **Step 3: Add package metadata and build entrypoints**

Create `packages/sdk/package.json` with this public shape:

```json
{
  "name": "@trading-backtester/sdk",
  "version": "0.1.0",
  "description": "Standalone authoring, contracts, artifacts and HTTP client SDK for trading-backtester.",
  "type": "module",
  "license": "Apache-2.0",
  "files": ["dist", "schemas", "README.md", "LICENSE"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./contracts": { "types": "./dist/contracts/index.d.ts", "import": "./dist/contracts/index.js" },
    "./builder": { "types": "./dist/builder/index.d.ts", "import": "./dist/builder/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./artifacts": { "types": "./dist/artifacts/index.d.ts", "import": "./dist/artifacts/index.js" }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run test",
    "prepack": "pnpm build"
  },
  "dependencies": {
    "decimal.js": "^10.4.3"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`decimal.js` is the SDK's only runtime dependency (it backs the canonical-number
quantizer moved in Task 4). It is an explicit registry dependency, not an
implicitly bundled import.

Create `packages/sdk/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    'builder/index': 'src/builder/index.ts',
    'client/index': 'src/client/index.ts',
    'artifacts/index': 'src/artifacts/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
});
```

Create minimal entrypoints. The root must stay identity-only:

```ts
// packages/sdk/src/internal/versions.ts
export const SDK_VERSION = '0.1.0' as const;
export const API_CONTRACT_VERSION = '017.2' as const;
export const ARTIFACT_CONTRACT_VERSION = '022.1' as const;
export const BUNDLE_CONTRACT_VERSION = '019.1' as const;
export const HISTORICAL_DATA_CONTRACT_VERSION = '030.1' as const;
export const SUPPORTED_API_CONTRACT_VERSIONS = [API_CONTRACT_VERSION] as const;

// packages/sdk/src/internal/shared-types.ts
// Single definition of the content-hash brand; re-exported by both contracts and artifacts.
export type ContentHash = `sha256:${string}`;

// packages/sdk/src/index.ts
export { SDK_VERSION, SUPPORTED_API_CONTRACT_VERSIONS } from './internal/versions';
export const SDK_CAPABILITIES = Object.freeze({
  contracts: true,
  builder: true,
  client: true,
  artifacts: true,
});
```

The four subpath `index.ts` files initially contain `export {};` so the export
map builds before the domain declarations arrive.

Extend the root test/typecheck globs so the SDK package is covered by the full
gates (not only by explicit-path invocations). In `vitest.config.ts` change the
include to:

```ts
include: [
  'apps/**/test/**/*.test.ts',
  'packages/**/test/**/*.test.ts',
  'scripts/**/*.test.ts',
],
```

In `tsconfig.json` extend `include` to add `packages/*/test` and `scripts/**/*.ts`:

```json
"include": [
  "packages/*/src",
  "packages/*/test",
  "apps/*/src",
  "apps/*/test",
  "scripts/**/*.ts",
  "vitest.config.ts"
]
```

The root `vitest` global setup (`apps/backtester/scripts/vitest-global-setup.mjs`)
still runs for the added suites; this is acceptable. The package-shape test must
now also pass under a full `pnpm test` run, not only under a direct path.

- [ ] **Step 4: Install and verify GREEN**

Run:

```bash
pnpm install
pnpm vitest run packages/sdk/test/package-shape.test.ts
pnpm --filter @trading-backtester/sdk build
```

Expected: package-shape test PASS; five ESM and declaration entrypoints exist
under `packages/sdk/dist`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk pnpm-lock.yaml
git commit -m "build(sdk): scaffold public package and subpath exports"
```

---

### Task 2: Establish canonical artifact and wire contracts

**Files:**
- Create: `packages/sdk/src/contracts/versions.ts`
- Create: `packages/sdk/src/contracts/module.ts`
- Create: `packages/sdk/src/contracts/run.ts`
- Create: `packages/sdk/src/contracts/validation.ts`
- Create: `packages/sdk/src/contracts/capabilities.ts`
- Create: `packages/sdk/src/artifacts/types.ts`
- Create: `packages/sdk/src/artifacts/guards.ts`
- Modify: `packages/sdk/src/contracts/index.ts`
- Modify: `packages/sdk/src/artifacts/index.ts`
- Create: `packages/sdk/test/contracts.test.ts`
- Create: `packages/sdk/test/artifacts.test.ts`
- Modify: `apps/backtester/test/client-parity.test.ts`

- [ ] **Step 1: Write failing contract and artifact tests**

Create tests that import from source entrypoints until the package build exists:

```ts
// packages/sdk/test/artifacts.test.ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isContentHash,
  type ArtifactManifest,
  type ContentHash,
} from '../src/artifacts/index';

describe('artifact contracts', () => {
  it('accepts only lowercase sha256 content references', () => {
    expect(isContentHash(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isContentHash(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isContentHash('sha256:short')).toBe(false);
  });

  it('keeps manifest content hashes typed', () => {
    expectTypeOf<ArtifactManifest['descriptors'][number]['contentHash']>()
      .toEqualTypeOf<ContentHash>();
  });
});
```

```ts
// packages/sdk/test/contracts.test.ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  BUNDLE_CONTRACT_VERSION,
  type ModuleBundle,
  type RunSubmitRequest,
} from '../src/contracts/index';

describe('public contracts', () => {
  it('pins the current contract versions', () => {
    expect(API_CONTRACT_VERSION).toBe('017.2');
    expect(BUNDLE_CONTRACT_VERSION).toBe('019.1');
    expect(ARTIFACT_CONTRACT_VERSION).toBe('022.1');
  });

  it('types submitted bundles and runs', () => {
    expectTypeOf<RunSubmitRequest['moduleBundle']>()
      .toEqualTypeOf<ModuleBundle | undefined>();
  });
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
pnpm vitest run packages/sdk/test/contracts.test.ts packages/sdk/test/artifacts.test.ts
```

Expected: FAIL with missing exports/files.

- [ ] **Step 3: Move the existing wire vocabulary into focused SDK files**

Use `packages/client/src/wire.ts` and
`packages/research-contracts/src/{run,comparison}.ts` as the exact current
behavioral source. Define each public name once in the SDK:

```text
contracts/module.ts
  BacktestEngine, ModuleKind, ModuleManifest, ModuleBundle

contracts/run.ts
  RunMode, Ref, RunPeriod, BacktestRunRequest, ModuleValidateRequest,
  RunSubmitRequest, RunJobHandle, RunStatus, RunStatusView,
  RunResultSummary, RunEvidence, CompletionEvent, ComparisonSummary

contracts/validation.ts
  ValidationStatus, ValidationIssue, ValidationReport,
  GatewayErrorCategory, GatewayError

contracts/capabilities.ts
  CapabilityDescriptor, DatasetDescriptor

internal/shared-types.ts
  ContentHash  (single definition; created in Task 1)

artifacts/types.ts
  ArtifactAvailability, ArtifactReference,
  ArtifactDescriptor, ArtifactManifest, ArtifactPage
  (imports ContentHash from ../internal/shared-types; re-exports it)
```

`contracts/run.ts` and `contracts/module.ts` import `ContentHash` from
`../internal/shared-types` (e.g. `RunEvidence.bundleHash`,
`RunResultSummary.resultHash`, `ArtifactReference.artifactId`). Both
`contracts/index.ts` and `artifacts/index.ts` re-export `ContentHash` so each
facade is self-contained and neither imports the other.

Keep every field and optionality equal to the current service wire DTO. Do not
copy comments that claim the new SDK is vendored. Re-export the single version
definitions from `contracts/versions.ts`:

```ts
export {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
  BUNDLE_CONTRACT_VERSION,
  HISTORICAL_DATA_CONTRACT_VERSION,
  SDK_VERSION,
} from '../internal/versions';
```

Implement the artifact guard:

```ts
import type { ContentHash } from './types';

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && CONTENT_HASH_RE.test(value);
}
```

Use curated exports only:

```ts
// contracts/index.ts
export * from './versions';
export type { ContentHash } from '../internal/shared-types';
export type * from './module';
export type * from './run';
export type * from './validation';
export type * from './capabilities';

// artifacts/index.ts
export type { ContentHash } from '../internal/shared-types';
export type * from './types';
export { isContentHash } from './guards';
```

- [ ] **Step 4: Point the temporary parity test at the new canonical source**

Change `apps/backtester/test/client-parity.test.ts` so the legacy client is
checked against SDK contracts, not against the private contracts package:

```ts
import type * as Client from '../../../packages/client/src/index';
import type * as SdkContracts from '../../../packages/sdk/src/contracts/index';
import type * as SdkArtifacts from '../../../packages/sdk/src/artifacts/index';
```

Retain the existing mutual-assignability checks, using `SdkArtifacts` for
artifact types and `SdkContracts` for run/validation types. This test is
explicitly temporary and is deleted after the later `trading-lab` cutover.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm vitest run \
  packages/sdk/test/contracts.test.ts \
  packages/sdk/test/artifacts.test.ts \
  apps/backtester/test/client-parity.test.ts
pnpm typecheck
```

Expected: all selected tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src packages/sdk/test apps/backtester/test/client-parity.test.ts
git commit -m "feat(sdk): establish canonical wire and artifact contracts"
```

---

### Task 3: Publish the two executable authoring ABIs and canonical schema assets

**Files:**
- Create: `packages/sdk/src/contracts/authoring.ts`
- Create: `packages/sdk/src/contracts/schema-assets.ts`
- Modify: `packages/sdk/src/contracts/module.ts`
- Modify: `packages/sdk/src/contracts/index.ts`
- Create: `packages/sdk/schemas/017/module-manifest.schema.json`
- Create: `packages/sdk/schemas/017/strategy-decision.schema.json`
- Create: `packages/sdk/schemas/017/overlay-decision.schema.json`
- Create: `packages/sdk/schemas/017/backtest-run-request.schema.json`
- Create: `packages/sdk/schemas/017/validation-result.schema.json`
- Create: `packages/sdk/test/authoring-contract.test.ts`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Write failing type/fixture tests for both ABIs**

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LifecycleModule,
  MomentumSignals,
  OverlayLifecycleModule,
  StrategyContext,
} from '../src/contracts/index';

describe('authoring ABI', () => {
  it('types the momentum function', () => {
    expectTypeOf<MomentumSignals>().toBeFunction();
  });

  it('requires apply on overlay modules', () => {
    const overlay: OverlayLifecycleModule = { apply: () => null };
    expect(typeof overlay.apply).toBe('function');
  });

  it('permits optional lifecycle hooks', () => {
    const module: LifecycleModule = {
      onBarClose: (_ctx: StrategyContext) => null,
      init: () => undefined,
      dispose: () => undefined,
    };
    expect(typeof module.onBarClose).toBe('function');
  });
});
```

Run and expect missing authoring types.

- [ ] **Step 2: Define the exact current executable ABIs**

Create `contracts/authoring.ts` by deriving the public authoring-facing subset
**explicitly from `research/context.ts` (`StrategyContext`, the bar/point-in-time
shapes), the hook-facing types of `research/indicators.ts` and
`research/market-tape.ts` (`SourceField`, `IndicatorRequest`, the indicator value
types, and `PointInTimeMarketApi` + its point/reading types) and the closed
decision vocabularies of `research/decision.ts` (`StrategyDecision`,
`OverlayDecision`)**. Copy these hook-facing shapes structurally identical so
authored modules stay assignable to the engine context. The file must NOT copy
engine *implementation* types: portfolio, execution, the indicator
catalog/validation types (`IndicatorDefinition`, `IndicatorCatalog`,
`IndicatorValidationResult`, etc.), the market-tape dataset/builder/coverage
types, or sandbox IPC/session models.

**Momentum `Candle` (approved decision):** the momentum bundle receives
`SymbolSeries.candles: readonly ReaderRow[]` where `ReaderRow =
historical.ts::CanonicalRow`. The public `Candle` is published as the EXACT
`CanonicalRow`/`ReaderRow` shape (`symbol`, `minute_ts`, OHLCV, `turnover`, the
optional OI/funding/taker columns and their `has_*` flags). This is the single
deliberate exception to "canonical rows stay private" (spec §6/decision 7): only
the row *shape* is published — `HistoricalDatasetReader`, its query/paging DTOs
and the data API stay private. Do NOT widen `Candle` to the on-disk
`research/canonical-row.ts::CanonicalRow` (which adds `schema_version`/`liq_*`);
match `historical.ts` exactly.

The exported top-level shapes must include:

```ts
export type MomentumSignals = (
  candles: readonly Candle[],
  seed: number,
) => readonly boolean[];

export interface LifecycleModule {
  init?(ctx: StrategyContext): void;
  onBarClose(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  onPositionBar?(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  onPendingIntentBar?(ctx: StrategyContext): StrategyDecision | readonly StrategyDecision[] | null;
  dispose?(ctx: StrategyContext): void;
}

export interface OverlayLifecycleModule {
  init?(ctx: StrategyContext): void;
  apply(ctx: StrategyContext): OverlayDecision | readonly OverlayDecision[] | null;
  dispose?(ctx: StrategyContext): void;
}

export type LifecycleModuleFactory<T extends LifecycleModule | OverlayLifecycleModule> =
  () => T;
```

Preserve the existing closed decision vocabularies and point-in-time semantics.
Do not export platform historical reader, storage row or sandbox IPC types.

- [ ] **Step 3: Move the five authoritative 017 schema assets into the SDK**

Copy the five committed files from `packages/research-contracts/schemas/017/`
byte-for-byte into `packages/sdk/schemas/017/`; do not regenerate or hand-edit
them in this task. Move `CoreSchemaName`, `SCHEMA_FILES`, `SCHEMA_IDS`,
`schemaAsset` and `allSchemaAssets` from
`packages/research-contracts/src/research/schema-assets.ts` into
`packages/sdk/src/contracts/schema-assets.ts`. Keep the resolver relative to
both source and compiled `dist/contracts`:

```ts
const SCHEMAS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  '017',
);
```

Export `CoreSchemaName`, `SCHEMA_FILES`, `SCHEMA_IDS`, `schemaAsset` and
`allSchemaAssets` from `/contracts`. The old private copies remain frozen only
for compatibility until the consumer cutover; Task 6 makes the running service
consume the SDK copies.

- [ ] **Step 4: Verify schema assets and ABI tests**

Extend `authoring-contract.test.ts` to call `allSchemaAssets()`, assert all five
assets load, their `$id` values equal `SCHEMA_IDS`, and the returned objects are
deep-equal to the current private assets. This parity assertion prevents drift
while the compatibility copies coexist.

Add a **version value-parity** assertion in the same test: import
`API_CONTRACT_VERSION` from `sdk/contracts` and `CONTRACT_VERSION` from
`@trading/research-contracts`, and assert they are equal (`017.2`). This keeps
the renamed SDK constant locked to the still-frozen private constant for the
coexistence window. Run:

```bash
pnpm vitest run packages/sdk/test/authoring-contract.test.ts
pnpm --filter @trading-backtester/sdk build
```

Expected: PASS and schemas remain present outside `dist` for packing.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/contracts packages/sdk/schemas packages/sdk/test packages/sdk/package.json
git commit -m "feat(sdk): publish executable ABI and schema assets"
```

---

### Task 4: Move the determinism core into the SDK and implement the deterministic builder

This task implements **option (a)** for the determinism core: the canonical-JSON
serializer, the contract-number quantizer and content hashing become a single
source of truth inside the SDK. The service's existing determinism modules turn
into thin re-export wrappers, so every current service/test import keeps working
while the implementation is no longer duplicated.

**Files:**
- Create: `packages/sdk/src/internal/canonical-json.ts`
- Create: `packages/sdk/src/internal/content-hash.ts`
- Modify: `packages/sdk/src/contracts/index.ts`
- Create: `packages/sdk/src/builder/manifest.ts`
- Create: `packages/sdk/src/builder/bundle.ts`
- Create: `packages/sdk/src/builder/preflight.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/builder.test.ts`
- Modify: `apps/backtester/src/determinism/canonical-json.ts` (→ thin wrapper)
- Modify: `apps/backtester/src/determinism/hash.ts` (→ thin wrapper)
- Modify: `apps/backtester/src/sandbox/bundle.ts`
- Modify: `apps/backtester/test/bundle.test.ts`
- Modify: `apps/backtester/package.json` (add SDK workspace dependency)
- Modify: `package.json` (add `sdk:build` + `pretypecheck`/`pretest` hooks)
- Modify: `pnpm-lock.yaml`

Note: `apps/backtester/src/engine/sandbox/bundle-hash.ts::computeBundleHash`
(the sandbox-integrity hash over a materialized directory) is **out of scope**
and is not renamed or touched. The SDK's public builder hash is named
`computeInlineBundleHash` to avoid the collision.

- [ ] **Step 1: Write failing builder tests**

Cover stable construction, insertion-order independence and unsafe paths:

```ts
import { describe, expect, it } from 'vitest';
import {
  computeInlineBundleHash,
  createModuleBundle,
  createModuleManifest,
  preflightValidateBundle,
} from '../src/builder/index';

const manifest = createModuleManifest({
  id: 'overlay-1',
  version: '1.0.0',
  kind: 'overlay',
});

describe('SDK builder', () => {
  it('hashes semantic file maps independently of insertion order', () => {
    const a = createModuleBundle({
      manifest,
      entry: 'index.js',
      files: { 'z.js': 'z', 'index.js': 'export default () => ({ apply: () => null })' },
    });
    const b = createModuleBundle({
      manifest,
      entry: 'index.js',
      files: { 'index.js': 'export default () => ({ apply: () => null })', 'z.js': 'z' },
    });
    expect(computeInlineBundleHash(a)).toBe(computeInlineBundleHash(b));
  });

  it('rejects traversal and missing entry files with authoritative-compatible codes', () => {
    const report = preflightValidateBundle({
      manifest,
      entry: 'missing.js',
      files: { '../escape.js': 'bad' },
    }, { engine: 'overlay' });
    expect(report.status).toBe('rejected');
    // Reuse the service's authoritative code; do NOT invent bundle_path_invalid.
    expect(new Set(report.issues.map((issue) => issue.code)))
      .toEqual(new Set(['bundle_entrypoint_invalid']));
    // Issues remain sorted by (path ?? '', code) for stable author output.
    const keys = report.issues.map((i) => `${i.path ?? ''} ${i.code}`);
    expect(keys).toEqual([...keys].sort());
  });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
pnpm vitest run packages/sdk/test/builder.test.ts
```

Expected: FAIL because builder functions do not exist.

- [ ] **Step 3: Move the determinism core into the SDK (verbatim semantics)**

Move the existing deterministic implementation from
`apps/backtester/src/determinism/canonical-json.ts` and
`apps/backtester/src/determinism/hash.ts` into the SDK **byte-for-byte**. This is
behavior-critical code (AGENTS.md invariant #1); do not simplify it. In
particular `canonical-json.ts` quantizes numbers via **`decimal.js`** (scale 8,
`ROUND_HALF_EVEN`, `-0 → 0`, fixed non-exponential notation, trailing `\n`,
recursive sorted keys, array order preserved). Carry that implementation across
unchanged and keep the public `quantize` helper, renamed to
`quantizeContractNumber`:

```ts
// internal/canonical-json.ts  (decimal.js-backed; moved verbatim from the service)
export function quantizeContractNumber(n: number): number { /* existing quantize body */ }
export function canonicalJson(value: unknown): string { /* existing body, unchanged */ }

// internal/content-hash.ts
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
export function contentRef(payload: unknown): ContentHash {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}
export function canonicalBundleHash(bundle: ModuleBundle): ContentHash {
  return contentRef(bundle);
}
```

`ContentHash` is imported from `../internal/shared-types`; `ModuleBundle` from
`../contracts/module` (type-only, so no runtime cycle).

Export the protocol primitives from `/contracts` as the single source of truth:

```ts
// contracts/index.ts
export { canonicalJson, quantizeContractNumber } from '../internal/canonical-json';
export { sha256Hex, contentRef, canonicalBundleHash } from '../internal/content-hash';
```

Wire the SDK as a built workspace dependency **before** converting the wrappers,
because the wrappers import the compiled `@trading-backtester/sdk/contracts`:

- add `"@trading-backtester/sdk": "workspace:*"` to `apps/backtester/package.json`;
- add the root `sdk:build` script and lifecycle hooks so the SDK `dist` exists
  before any service typecheck/test (these are also referenced by Task 6 Step 2
  and Task 7 Step 4 — introduce them here):

  ```json
  "sdk:build": "pnpm --filter @trading-backtester/sdk build",
  "pretypecheck": "pnpm sdk:build",
  "pretest": "pnpm sdk:build && pnpm run build:sandbox-harness-overlay"
  ```

- run `pnpm install` then `pnpm sdk:build`.

Then convert the two service determinism files into **thin re-export wrappers**
so existing service and golden-test imports (`'../determinism/hash'`,
`'../determinism/canonical-json'`) keep resolving with no behavior change and no
second implementation:

```ts
// apps/backtester/src/determinism/canonical-json.ts  (wrapper)
export { canonicalJson } from '@trading-backtester/sdk/contracts';
export { quantizeContractNumber as quantize } from '@trading-backtester/sdk/contracts';

// apps/backtester/src/determinism/hash.ts  (wrapper)
export { sha256Hex, contentRef } from '@trading-backtester/sdk/contracts';
```

The `/builder` facade exports `computeInlineBundleHash`, which delegates to
`canonicalBundleHash`. There is exactly one serialization and hash algorithm; the
service reaches it through these wrappers and `sandbox/bundle.ts::bundleHash`
keeps calling `contentRef` unchanged.

- [ ] **Step 4: Implement manifest, bundle and preflight helpers**

`createModuleManifest` pins `BUNDLE_CONTRACT_VERSION` and freezes the result.
`createModuleBundle` sorts file keys into a new frozen record. Reject paths that
are absolute, empty, contain `..` segments, backslashes or NUL bytes.

`preflightValidateBundle` returns:

```ts
export interface PreflightOptions {
  readonly engine: BacktestEngine;
}

export function preflightValidateBundle(
  input: unknown,
  options: PreflightOptions,
): ValidationReport;
```

Sort issues by `(path ?? '', code)`. Check manifest shape/kind/version, entry
presence, every file path, selected engine and declared module kind. Do not
import or execute source.

Use only issue codes that the authoritative service validation already emits
(see `apps/backtester/src/sandbox/bundle.ts::validateBundle`):
`schema_invalid`, `unsupported_module_kind`, `unsupported_contract_version` and
`bundle_entrypoint_invalid` (used for both bad file paths and a missing/absent
entry). Do not introduce a new `bundle_path_invalid` code.

The `/builder` facade exports the public name that delegates to the shared
primitive:

```ts
// builder/index.ts
import { canonicalBundleHash } from '../contracts';
export function computeInlineBundleHash(bundle: ModuleBundle): ContentHash {
  return canonicalBundleHash(bundle);
}
export { createModuleManifest } from './manifest';
export { createModuleBundle } from './bundle';
export { preflightValidateBundle } from './preflight';
```

- [ ] **Step 5: Add a service/SDK golden hash assertion**

Modify `apps/backtester/test/bundle.test.ts` to build one fixture through the
SDK and assert `computeInlineBundleHash(bundle)` equals the service registry
hash `apps/backtester/src/sandbox/bundle.ts::bundleHash(bundle)` exactly (this is
the registry-identity hash, not the sandbox-integrity
`engine/sandbox/bundle-hash.ts::computeBundleHash`). Preserve the existing golden
value instead of regenerating it silently.

Because the service determinism files are now wrappers over the SDK, the
existing frozen golden `result_hash` / fingerprint snapshots
(`determinism.test.ts`, `momentum-guardrail.test.ts`, `overlay-golden.test.ts`,
`overlay-sandbox-equivalence.test.ts`, …) double as the byte-parity guard for
the moved core: they must stay green with their current values, proving the move
changed no bytes.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
pnpm sdk:build
pnpm vitest run \
  packages/sdk/test/builder.test.ts \
  apps/backtester/test/bundle.test.ts \
  apps/backtester/test/determinism.test.ts \
  apps/backtester/test/momentum-guardrail.test.ts \
  apps/backtester/test/overlay-golden.test.ts
pnpm typecheck
```

Expected: PASS; existing bundle and `result_hash` goldens remain unchanged
(byte-parity proof that the moved core is behavior-identical).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src packages/sdk/test packages/sdk/package.json \
  apps/backtester/src/determinism apps/backtester/src/sandbox/bundle.ts \
  apps/backtester/test/bundle.test.ts \
  apps/backtester/package.json package.json pnpm-lock.yaml
git commit -m "feat(sdk): add deterministic builder and move canonical hashing core"
```

---

### Task 5: Move the typed HTTP client into the SDK

**Files:**
- Create: `packages/sdk/src/client/errors.ts`
- Create: `packages/sdk/src/client/client.ts`
- Modify: `packages/sdk/src/client/index.ts`
- Create: `apps/backtester/test/sdk-client.test.ts`

- [ ] **Step 1: Write a failing SDK client integration test**

Copy `apps/backtester/test/client.test.ts` wholesale to
`apps/backtester/test/sdk-client.test.ts`. Preserve its real in-process app,
fixtures, authentication, cleanup and assertions. Change only the suite title
and the client import:

```ts
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
```

This deliberately duplicates one integration test during the compatibility
window so both clients are exercised against identical HTTP behavior.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm vitest run apps/backtester/test/sdk-client.test.ts
```

Expected: FAIL because `BacktesterClient` is not exported.

- [ ] **Step 3: Move client behavior without changing routes**

Move the existing fetch abstractions, constructor normalization, request helper
and methods from `packages/client/src/client.ts` into the SDK. Import all DTOs
from `../contracts/index` and `../artifacts/index`; do not redeclare wire types.

Keep these method signatures:

```ts
getCapabilities(): Promise<CapabilityDescriptor>;
listDatasets(): Promise<DatasetDescriptor[]>;
validateModule(req: ModuleValidateRequest): Promise<ValidationReport>;
submitRun(req: RunSubmitRequest): Promise<RunJobHandle>;
getRunStatus(runId: string): Promise<RunStatusView>;
getRunResult(runId: string): Promise<RunResultSummary>;
getArtifactManifest(runId: string): Promise<ArtifactManifest>;
readArtifact(runId: string, artifactId: string, opts?: ReadArtifactOptions): Promise<ArtifactPage>;
cancelRun(runId: string): Promise<RunStatusView>;
awaitCompletion(runId: string, opts?: AwaitCompletionOptions): Promise<RunStatusView>;
```

Preserve `awaitCompletion` and its `AwaitCompletionOptions` (injectable
`sleep`/`intervalMs`/`timeoutMs`) verbatim from the existing client — it is part
of the public surface the current `trading-lab` adapter relies on; do not drop
it. Move the existing error classes and status mapping unchanged. The SDK client
entrypoint exports the class, error classes and client option interfaces
(including `AwaitCompletionOptions` and `ReadArtifactOptions`) only.

- [ ] **Step 4: Run old and new client suites together**

```bash
pnpm vitest run apps/backtester/test/sdk-client.test.ts apps/backtester/test/client.test.ts
pnpm typecheck
```

Expected: both implementations pass against the same real HTTP behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/client apps/backtester/test/sdk-client.test.ts
git commit -m "feat(sdk): expose typed backtester HTTP client"
```

---

### Task 6: Make SDK contracts canonical at the service boundary

**Files:**
- Modify: `apps/backtester/package.json`
- Modify: `apps/backtester/src/api/server.ts`
- Modify: `apps/backtester/src/engine/validation/schema-registry.ts`
- Modify: `apps/backtester/src/artifacts/store.ts`
- Modify: `apps/backtester/src/artifacts/overlay-store.ts`
- Modify: `apps/backtester/src/jobs/completion.ts`
- Modify: `apps/backtester/src/jobs/fingerprint.ts`
- Modify: `apps/backtester/src/jobs/submit.ts`
- Modify: `apps/backtester/src/jobs/types.ts`
- Modify: `apps/backtester/src/jobs/worker.ts`
- Modify: `apps/backtester/src/sandbox/bundle.ts`
- Modify: `apps/backtester/test/contract-merge-guard.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add a failing boundary guard**

Extend `contract-merge-guard.test.ts` to scan public-boundary files and reject
imports of public wire types from the old package:

```ts
const PUBLIC_BOUNDARY_FILES = [
  'src/api/server.ts',
  'src/artifacts/store.ts',
  'src/artifacts/overlay-store.ts',
  'src/jobs/completion.ts',
  'src/jobs/fingerprint.ts',
  'src/jobs/submit.ts',
  'src/jobs/types.ts',
  'src/jobs/worker.ts',
  'src/sandbox/bundle.ts',
] as const;

// Public wire DTOs that MUST now come from the SDK, not the private package.
const PUBLIC_WIRE_NAMES = [
  'ModuleBundle', 'ModuleManifest', 'ModuleKind', 'BacktestEngine',
  'RunSubmitRequest', 'RunJobHandle', 'RunStatus', 'RunStatusView',
  'RunResultSummary', 'RunEvidence', 'ComparisonSummary', 'CompletionEvent',
  'ModuleValidateRequest', 'ValidationReport', 'ValidationIssue',
  'GatewayError', 'GatewayErrorCategory', 'CapabilityDescriptor',
  'DatasetDescriptor', 'ContentHash', 'ArtifactReference', 'ArtifactDescriptor',
  'ArtifactManifest', 'ArtifactPage', 'ArtifactAvailability',
  'API_CONTRACT_VERSION', 'ARTIFACT_CONTRACT_VERSION', 'BUNDLE_CONTRACT_VERSION',
  'SCHEMA_IDS', 'schemaAsset', 'CoreSchemaName',
] as const;

for (const rel of PUBLIC_BOUNDARY_FILES) {
  const source = readFileSync(join(APP_ROOT, rel), 'utf8');
  // Distinguish public DTOs from private engine models: reject ONLY public wire
  // names imported from the old package; private engine/historical imports
  // (HistoricalDatasetReader, CanonicalRow, engine profiles, StrategyContext,
  // sandbox IPC) from '@trading/research-contracts' stay allowed.
  for (const m of source.matchAll(/import[^;]*?from\s+'(@trading\/research-contracts[^']*)'/g)) {
    const stmt = m[0];
    for (const name of PUBLIC_WIRE_NAMES) {
      expect(stmt.includes(name), `${rel} imports public wire ${name} from the private package`).toBe(false);
    }
  }
}
```

Run and expect RED because these files still import public wire names from the
old root package. The guard intentionally still allows private engine/historical
imports from `@trading/research-contracts`.

- [ ] **Step 2: Confirm the SDK workspace dependency and build hooks**

The `"@trading-backtester/sdk": "workspace:*"` dependency in
`apps/backtester/package.json` and the root `sdk:build` / `pretypecheck` /
`pretest` lifecycle hooks were introduced in Task 4 (to support the determinism
wrappers). Verify they are present; if a clean branch starts at Task 6, add them
now:

```json
// apps/backtester/package.json
"@trading-backtester/sdk": "workspace:*"
```

```json
// package.json (root)
"sdk:build": "pnpm --filter @trading-backtester/sdk build",
"pretypecheck": "pnpm sdk:build",
"pretest": "pnpm sdk:build && pnpm run build:sandbox-harness-overlay"
```

Keep `@trading/research-contracts` for private historical/engine types.

- [ ] **Step 3: Migrate public boundary imports**

Use Gortex `get_edit_plan`/`batch_edit` to replace imports by ownership:

```ts
import type {
  RunSubmitRequest,
  RunStatusView,
  RunResultSummary,
  ValidationReport,
} from '@trading-backtester/sdk/contracts';
import {
  API_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
} from '@trading-backtester/sdk/contracts';
import type {
  ArtifactManifest,
  ArtifactPage,
  ArtifactReference,
  ContentHash,
} from '@trading-backtester/sdk/artifacts';
import {
  SCHEMA_IDS,
  schemaAsset,
  type CoreSchemaName,
} from '@trading-backtester/sdk/contracts';
```

Do not replace imports of `HistoricalDatasetReader`, `CanonicalRow`, engine
profiles, indicators or internal sandbox context; those remain private.
In `schema-registry.ts`, switch only `SCHEMA_IDS`, `schemaAsset` and
`CoreSchemaName` to the SDK so authoritative AJV validation loads the packaged
public assets. Keep AJV compilation, error mapping and author-supplied parameter
schema handling in the service.

- [ ] **Step 4: Remove local public DTO/hash definitions**

Delete service-local declarations only when the SDK owns the exact same public
shape. Import `canonicalBundleHash` from `@trading-backtester/sdk/contracts`
instead of retaining a second implementation. Preserve internal database rows
and job-store models even when they look similar to wire DTOs.

- [ ] **Step 5: Run focused API/job/artifact suites**

```bash
pnpm vitest run \
  apps/backtester/test/contract-merge-guard.test.ts \
  apps/backtester/test/client.test.ts \
  apps/backtester/test/terminal-result-api.test.ts \
  apps/backtester/test/api.e2e.test.ts \
  apps/backtester/test/completion.test.ts \
  apps/backtester/test/idempotency.test.ts
pnpm typecheck
```

Expected: boundary guard and behavioral suites PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester packages/sdk pnpm-lock.yaml
git commit -m "refactor(sdk): make public contracts canonical in the service"
```

---

### Task 7: Prove the tarball is standalone and licensed

**Files:**
- Create: `packages/sdk/LICENSE`
- Create: `packages/sdk/README.md`
- Create: `scripts/verify-sdk-package.ts`
- Create: `scripts/verify-sdk-clean-consumer.ts`
- Create: `packages/sdk/test/package-content.test.ts`
- Modify: `packages/sdk/package.json`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write a failing package verifier test**

Create `package-content.test.ts` around exported pure verifier functions:

```ts
import { describe, expect, it } from 'vitest';
import { checkPackedPackage } from '../../../scripts/verify-sdk-package';

describe('SDK packed package policy', () => {
  it('rejects workspace dependencies and forbidden files', () => {
    expect(checkPackedPackage({
      packageJson: { dependencies: { bad: 'workspace:*' } },
      files: ['package/src/internal.ts'],
    })).toEqual([
      'dependency bad uses forbidden specifier workspace:*',
      'forbidden packed path package/src/internal.ts',
    ]);
  });
});
```

Implement the verifier in TypeScript so Vitest and the repository typecheck
validate the same exported pure function used by its CLI entrypoint.

- [ ] **Step 2: Implement pack inspection**

`checkPackedPackage` must reject:

- dependency specifiers containing `workspace:`, `file:`, `link:` or sibling
  paths;
- packed `src`, `test`, `.env`, workspace configs or application code;
- absent LICENSE, README, dist entrypoints or schemas;
- package name/version/license mismatch;
- missing root or subpath export targets.

It must **allow** a normal registry semver dependency: `decimal.js` is the one
declared runtime dependency and must pass (only `workspace:`/`file:`/`link:`/
sibling-path specifiers are forbidden, not registry ranges).

The CLI mode accepts a tarball path, obtains its JSON file listing with
`tar -tzf`, reads `package/package.json`, prints every error and exits 1 when the
array is non-empty.

- [ ] **Step 3: Add Apache-2.0 and consumer documentation**

Add the unmodified Apache License 2.0 text to `packages/sdk/LICENSE`.

README must document:

- exact GitHub Release URL installation;
- all five import paths;
- momentum and lifecycle ABI examples;
- local preflight versus authoritative service validation;
- no live-order/exchange credential authority;
- bounded artifact reads;
- supported Node version and ESM requirement.

- [ ] **Step 4: Add root scripts and ignore generated tarballs**

Add (the `sdk:build` script already exists from Task 4 — add only the pack and
verify scripts):

```json
"sdk:pack": "mkdir -p .artifacts/sdk && pnpm --filter @trading-backtester/sdk pack --pack-destination ../../.artifacts/sdk",
"sdk:verify": "tsx scripts/verify-sdk-package.ts .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz"
```

Ignore `.artifacts/sdk/` while keeping no tarball in Git.

- [ ] **Step 5: Run clean-consumer verification**

Implement `verify-sdk-clean-consumer.ts` so it creates a temporary directory
outside the repo, writes a `package.json` with the absolute tarball as the SDK
dependency and TypeScript as a dev dependency, writes a strict NodeNext
`tsconfig.json`, and writes these two smoke files:

```ts
// smoke.ts: compile-time coverage of all public entrypoints
import { SDK_VERSION } from '@trading-backtester/sdk';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';
void [SDK_VERSION, createModuleManifest, BacktesterClient, isContentHash];
const bundle: ModuleBundle | undefined = undefined;
void bundle;
```

```js
// smoke.mjs: runtime ESM coverage
import { SDK_VERSION } from '@trading-backtester/sdk';
import { allSchemaAssets } from '@trading-backtester/sdk/contracts';
import {
  createModuleManifest,
  createModuleBundle,
  computeInlineBundleHash,
} from '@trading-backtester/sdk/builder';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';
if (SDK_VERSION !== '0.1.0') process.exit(1);
if (typeof createModuleManifest !== 'function') process.exit(1);
if (typeof BacktesterClient !== 'function') process.exit(1);
if (!isContentHash(`sha256:${'a'.repeat(64)}`)) process.exit(1);
// Schema assets must resolve from the installed tarball, not the repo layout.
if (allSchemaAssets().length !== 5) process.exit(1);
// Build + hash a fixture bundle so decimal.js + the codec resolve at runtime.
const manifest = createModuleManifest({ id: 'smoke', version: '1.0.0', kind: 'overlay' });
const bundle = createModuleBundle({
  manifest,
  entry: 'index.js',
  files: { 'index.js': 'export default () => ({ apply: () => null })' },
});
if (!isContentHash(computeInlineBundleHash(bundle))) process.exit(1);
```

The verifier runs `pnpm install --lockfile-only`, then
`pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit` and
`node smoke.mjs`, removes its temporary directory in `finally`, and propagates
any non-zero exit. Then run:

```bash
pnpm sdk:build
pnpm sdk:pack
pnpm sdk:verify
pnpm exec tsx scripts/verify-sdk-clean-consumer.ts .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz
```

Expected: exit 0 without access to repository workspace packages.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk scripts package.json .gitignore pnpm-lock.yaml
git commit -m "build(sdk): verify standalone licensed release tarball"
```

---

### Task 8: Add CI and manual GitHub Release automation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/sdk-release.yml`
- Create: `scripts/sdk-release-manifest.ts`
- Create: `scripts/sdk-release-manifest.test.ts`

- [ ] **Step 1: Write a failing source-manifest test**

```ts
import { describe, expect, it } from 'vitest';
import { releaseManifest } from './sdk-release-manifest';

describe('SDK release manifest', () => {
  it('records package version, source SHA and asset checksum', () => {
    expect(releaseManifest({
      version: '0.1.0',
      sourceSha: 'abc123',
      asset: 'trading-backtester-sdk-0.1.0.tgz',
      sha256: 'f'.repeat(64),
    })).toEqual({
      package: '@trading-backtester/sdk',
      version: '0.1.0',
      sourceSha: 'abc123',
      asset: 'trading-backtester-sdk-0.1.0.tgz',
      sha256: 'f'.repeat(64),
    });
  });
});
```

- [ ] **Step 2: Implement the deterministic manifest writer**

```ts
export interface ReleaseManifestInput {
  readonly version: string;
  readonly sourceSha: string;
  readonly asset: string;
  readonly sha256: string;
}

export function releaseManifest(input: ReleaseManifestInput) {
  return {
    package: '@trading-backtester/sdk' as const,
    version: input.version,
    sourceSha: input.sourceSha,
    asset: input.asset,
    sha256: input.sha256,
  };
}
```

The CLI receives positional `version sourceSha asset sha256 outputPath`, rejects
missing values, constructs `input`, and writes
`JSON.stringify(releaseManifest(input), null, 2) + '\n'`.
Keep file IO outside `releaseManifest` so the unit test remains pure.

- [ ] **Step 3: Add SDK gates to normal CI**

After the existing install/typecheck/test steps, run:

```yaml
- name: Build and inspect public SDK
  run: |
    pnpm sdk:build
    pnpm sdk:pack
    pnpm sdk:verify
    pnpm exec tsx scripts/verify-sdk-clean-consumer.ts .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz
```

Do not remove existing service, sandbox or Postgres checks.

- [ ] **Step 4: Add a manual release workflow**

Create `sdk-release.yml` with `workflow_dispatch` input `version`,
`permissions: contents: write`, the same pinned Node/pnpm setup as CI, and job
environment `VERSION: ${{ inputs.version }}`. Run these fail-closed checks:

```bash
node -e 'if (!/^\d+\.\d+\.\d+$/.test(process.env.VERSION ?? "")) process.exit(1)'
test "$(node -p "require('./packages/sdk/package.json').version")" = "$VERSION"
! git ls-remote --exit-code --tags origin "refs/tags/sdk-v$VERSION" >/dev/null 2>&1
! gh release view "sdk-v$VERSION" >/dev/null 2>&1
pnpm check
pnpm sdk:build
pnpm sdk:pack
pnpm sdk:verify
```

Generate checksum and JSON manifest with exact artifact names:

```bash
ASSET=".artifacts/sdk/trading-backtester-sdk-$VERSION.tgz"
SHA256="$(sha256sum "$ASSET" | cut -d' ' -f1)"
printf '%s  %s\n' "$SHA256" "$(basename "$ASSET")" > "$ASSET.sha256"
pnpm exec tsx scripts/sdk-release-manifest.ts \
  "$VERSION" "$GITHUB_SHA" "$(basename "$ASSET")" "$SHA256" \
  ".artifacts/sdk/trading-backtester-sdk-$VERSION.manifest.json"
```

Then use the preinstalled `gh` CLI. Let GitHub create the tag with the release
instead of pushing a tag before asset upload succeeds:

```bash
gh release create "sdk-v$VERSION" \
  ".artifacts/sdk/trading-backtester-sdk-$VERSION.tgz" \
  ".artifacts/sdk/trading-backtester-sdk-$VERSION.tgz.sha256" \
  ".artifacts/sdk/trading-backtester-sdk-$VERSION.manifest.json" \
  --target "$GITHUB_SHA" \
  --title "@trading-backtester/sdk $VERSION" \
  --notes "Public standalone trading-backtester SDK $VERSION"
```

The workflow is manual and must not run during this implementation plan.

- [ ] **Step 5: Verify workflow and script tests**

```bash
pnpm vitest run scripts/sdk-release-manifest.test.ts
pnpm sdk:build
pnpm sdk:pack
pnpm sdk:verify
```

Expected: PASS. Confirm no tag or release was created.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows scripts package.json
git commit -m "ci(sdk): add package gates and manual release workflow"
```

---

### Task 9: Update repository documentation without claiming consumer cutover

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `Dockerfile`
- Test: `packages/sdk/test/package-shape.test.ts`

- [ ] **Step 1: Add a documentation assertion to the package test**

```ts
it('documents the migration boundary honestly', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toContain('GitHub Release');
  expect(readme).toContain('authoritative validation');
  expect(readme).not.toContain('live order');
});
```

Run and verify RED until package README is complete.

- [ ] **Step 2: Update repository docs**

Document this exact state:

- `@trading-backtester/sdk` is the new canonical public package;
- `packages/client` is frozen pending the separate `trading-lab` cutover;
- `@trading/research-contracts` remains private for historical/engine-only
  types;
- release workflow exists but `0.1.0` has not been published by this plan;
- no live execution or exchange credentials were introduced.

Update the architecture package diagram and replace Docker comments/scripts
that assume only `@trading-backtester/client` is built. Docker must build the
SDK as well while retaining the legacy client until cutover.

- [ ] **Step 3: Run documentation/package checks**

```bash
pnpm vitest run packages/sdk/test/package-shape.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md docs/ARCHITECTURE.md Dockerfile packages/sdk/test/package-shape.test.ts
git commit -m "docs(sdk): document public package and migration boundary"
```

---

### Task 10: Final acceptance checkpoint

**Files:**
- Verify only; modify files only if a failing gate exposes a real defect.

- [ ] **Step 1: Verify no forbidden production dependency escaped**

```bash
rg -n 'workspace:|file:\.\./|link:\.\./' packages/sdk/package.json packages/sdk/dist
# Reject a trading-platform PACKAGE import/dependency, not the substring itself:
rg -n "from '@trading-platform|require\(['\"]@trading-platform|\"@trading-platform" \
  packages/sdk/src packages/sdk/dist packages/sdk/package.json
rg -n 'exchange credential|live order' packages/sdk/src packages/sdk/dist
```

Expected: no dependency/path leaks. Note the moved `SCHEMA_IDS` and the schema
`$id` values legitimately contain the stable identifier
`https://trading-platform/017/...` (a parity anchor with the platform schema id,
not a dependency); the refined check above matches only an actual
`@trading-platform` package import/dependency, so those identifiers are allowed.
Documentation-only boundary wording is allowed only in README and must not
appear in runtime source or declarations.

- [ ] **Step 2: Run the focused SDK suite**

```bash
pnpm vitest run packages/sdk/test apps/backtester/test/client-parity.test.ts \
  apps/backtester/test/client.test.ts apps/backtester/test/sdk-client.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run full repository verification**

```bash
pnpm typecheck
pnpm test
```

Expected: exit 0, zero failed tests. Existing Docker-gated skips may remain only
when their documented environmental prerequisite is unavailable.

- [ ] **Step 4: Rebuild and inspect the final tarball from a clean state**

```bash
rm -rf packages/sdk/dist .artifacts/sdk
pnpm sdk:build
pnpm sdk:pack
pnpm sdk:verify
pnpm exec tsx scripts/verify-sdk-clean-consumer.ts .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz
tar -tzf .artifacts/sdk/trading-backtester-sdk-0.1.0.tgz
```

Expected: only approved `dist`, schemas, README, LICENSE and package metadata;
clean consumer exits 0.

- [ ] **Step 5: Verify Git/release safety**

```bash
git status --short
git tag --list 'sdk-v0.1.0'
git ls-files '*.tgz' '.artifacts/**'
```

Expected: worktree contains only intentional source changes; no release tag and
no generated tarball are tracked.

- [ ] **Step 6: Commit verification fixes under their owning task**

If verification exposes a defect, return to the task that introduced it, add a
focused regression assertion, implement the minimum fix, rerun Task 10 from
Step 1 and commit with that task's explicit file list. If no defect is found,
do not create an empty checkpoint commit.

Stop after this checkpoint. Do not publish `sdk-v0.1.0`, edit `trading-lab`,
delete the legacy client or open a PR without a separate request.

---

## Spec coverage matrix

| Spec requirement | Plan task |
|---|---|
| One package/four subpaths | Task 1 |
| SDK tests/scripts covered by full gates (vitest/tsconfig globs) | Task 1 |
| `ContentHash` single source in `internal/shared-types` | Tasks 1 and 2 |
| Canonical public DTO source | Tasks 2 and 6 |
| Version value-parity (`API_CONTRACT_VERSION` ≡ `CONTRACT_VERSION`) | Task 3 |
| Momentum + lifecycle authoring ABI (from `research/context.ts`, no engine-only) | Task 3 |
| Packaged schemas drive authoritative validation | Tasks 3 and 6 |
| One determinism core + `decimal.js` runtime dependency (option a) | Task 4 |
| Deterministic builder/hash/preflight; `computeInlineBundleHash` vs sandbox-integrity hash | Task 4 |
| Authoritative-compatible preflight codes (no `bundle_path_invalid`) | Task 4 |
| Typed HTTP client incl. `awaitCompletion` | Task 5 |
| Artifact facade and bounded DTO | Task 2 |
| Service consumes SDK contracts | Task 6 |
| Boundary guard distinguishes public SDK DTOs from private engine models | Task 6 |
| Standalone package/no workspace leaks | Task 7 |
| Clean-consumer resolves `allSchemaAssets()` from the tarball | Task 7 |
| Apache-2.0 | Task 7 |
| GitHub Release assets/checksum/manifest | Task 8 |
| No public client wrapper; frozen client until cutover | Tasks 6 and 9 |
| Research-only/sandbox unchanged | Tasks 9 and 10 |
| Full verification | Task 10 |
