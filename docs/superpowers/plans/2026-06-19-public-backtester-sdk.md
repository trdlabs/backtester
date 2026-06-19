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
│   │   ├── canonical-json.ts            # stable JSON serialization
│   │   └── content-hash.ts              # sha256 content references
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
- Create: `packages/sdk/src/contracts/index.ts`
- Create: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/src/client/index.ts`
- Create: `packages/sdk/src/artifacts/index.ts`
- Create: `packages/sdk/test/package-shape.test.ts`
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
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

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

artifacts/types.ts
  ContentHash, ArtifactAvailability, ArtifactReference,
  ArtifactDescriptor, ArtifactManifest, ArtifactPage
```

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
export type * from './module';
export type * from './run';
export type * from './validation';
export type * from './capabilities';

// artifacts/index.ts
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

Create `contracts/authoring.ts` by moving the public authoring-facing subset of
the existing research types: bars, point-in-time context, decisions and hooks.
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
while the compatibility copies coexist. Run:

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

### Task 4: Implement the deterministic builder and share bundle hashing with the service

**Files:**
- Create: `packages/sdk/src/internal/canonical-json.ts`
- Create: `packages/sdk/src/internal/content-hash.ts`
- Modify: `packages/sdk/src/contracts/index.ts`
- Create: `packages/sdk/src/builder/manifest.ts`
- Create: `packages/sdk/src/builder/bundle.ts`
- Create: `packages/sdk/src/builder/preflight.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/builder.test.ts`
- Modify: `apps/backtester/src/sandbox/bundle.ts`
- Modify: `apps/backtester/src/determinism/hash.ts`
- Modify: `apps/backtester/test/bundle.test.ts`

- [ ] **Step 1: Write failing builder tests**

Cover stable construction, insertion-order independence and unsafe paths:

```ts
import { describe, expect, it } from 'vitest';
import {
  computeBundleHash,
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
    expect(computeBundleHash(a)).toBe(computeBundleHash(b));
  });

  it('rejects traversal and missing entry files in stable order', () => {
    const report = preflightValidateBundle({
      manifest,
      entry: 'missing.js',
      files: { '../escape.js': 'bad' },
    }, { engine: 'overlay' });
    expect(report.status).toBe('rejected');
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'bundle_entrypoint_invalid',
      'bundle_path_invalid',
    ]);
  });
});
```

- [ ] **Step 2: Run and verify RED**

```bash
pnpm vitest run packages/sdk/test/builder.test.ts
```

Expected: FAIL because builder functions do not exist.

- [ ] **Step 3: Move canonical serialization into the SDK**

Move the existing deterministic implementation from
`apps/backtester/src/determinism/canonical-json.ts` and
`apps/backtester/src/determinism/hash.ts` without changing its semantics:

```ts
export function canonicalJson(value: unknown): string {
  return `${serialize(value)}\n`;
}

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

Export `canonicalBundleHash` from `/contracts` as the low-level shared primitive.
`computeBundleHash` in `/builder` delegates to it. The service imports
`canonicalBundleHash` from `@trading-backtester/sdk/contracts`; there must be
only one serialization and hash algorithm. Add this curated export:

```ts
export { canonicalBundleHash } from '../internal/content-hash';
```

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

- [ ] **Step 5: Add a service/SDK golden hash assertion**

Modify `apps/backtester/test/bundle.test.ts` to build one fixture through the
SDK and assert both the SDK helper and service bundle store use the same exact
hash. Preserve the existing golden value instead of regenerating it silently.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
pnpm vitest run packages/sdk/test/builder.test.ts apps/backtester/test/bundle.test.ts
pnpm typecheck
```

Expected: PASS; existing bundle golden remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src packages/sdk/test \
  apps/backtester/src/determinism apps/backtester/src/sandbox/bundle.ts \
  apps/backtester/test/bundle.test.ts
git commit -m "feat(sdk): add deterministic bundle builder and canonical hashing"
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
```

Move the existing error classes and status mapping unchanged. The SDK client
entrypoint exports the class, error classes and client option interfaces only.

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

for (const rel of PUBLIC_BOUNDARY_FILES) {
  const source = readFileSync(join(APP_ROOT, rel), 'utf8');
  expect(source).not.toContain("from '@trading/research-contracts'");
}
```

Run and expect RED because these files still import the old root package.

- [ ] **Step 2: Add the SDK workspace dependency**

Change `apps/backtester/package.json`:

```json
"@trading-backtester/sdk": "workspace:*"
```

Keep `@trading/research-contracts` for private historical/engine types.

Because the SDK package exports compiled `dist`, update the root lifecycle
scripts so clean workspaces build it before service consumers run:

```json
"pretypecheck": "pnpm sdk:build",
"pretest": "pnpm sdk:build && pnpm run build:sandbox-harness-overlay"
```

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

Add:

```json
"sdk:build": "pnpm --filter @trading-backtester/sdk build",
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
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';
if (SDK_VERSION !== '0.1.0') process.exit(1);
if (typeof createModuleManifest !== 'function') process.exit(1);
if (typeof BacktesterClient !== 'function') process.exit(1);
if (!isContentHash(`sha256:${'a'.repeat(64)}`)) process.exit(1);
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
rg -n 'trading-platform|exchange credential|live order' packages/sdk/src packages/sdk/dist
```

Expected: no dependency/path leaks. Documentation-only boundary wording is
allowed only in README and must not appear in runtime source or declarations.

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
| Canonical public DTO source | Tasks 2 and 6 |
| Momentum + lifecycle authoring ABI | Task 3 |
| Packaged schemas drive authoritative validation | Tasks 3 and 6 |
| Deterministic builder/hash/preflight | Task 4 |
| Typed HTTP client | Task 5 |
| Artifact facade and bounded DTO | Task 2 |
| Service consumes SDK contracts | Task 6 |
| Standalone package/no workspace leaks | Task 7 |
| Apache-2.0 | Task 7 |
| GitHub Release assets/checksum/manifest | Task 8 |
| No wrapper; frozen client until cutover | Tasks 6 and 9 |
| Research-only/sandbox unchanged | Tasks 9 and 10 |
| Full verification | Task 10 |
