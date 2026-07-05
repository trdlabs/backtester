# Public `@trading-backtester/sdk` Design

**Status:** approved design

**Date:** 2026-06-19

**Owning repository:** `trading-backtester`

**Target package:** `@trading-backtester/sdk@0.1.0`

## 1. Context

`trading-backtester` currently exposes a private workspace package,
`@trading-backtester/client`, while `trading-lab` consumes it through a sibling
path dependency:

```json
"@trading-backtester/client": "file:../trading-backtester/packages/client"
```

The client is deliberately self-contained, but achieves that by keeping a
vendored copy of public wire DTOs in `packages/client/src/wire.ts`. A compile-time
parity test compares that copy with the private, source-only
`@trading/research-contracts` workspace package.

The executable module authoring helpers are in a second, historically derived
location: `@trading-platform/sdk/builder`. That surface creates the platform's
rich contract-017 manifest and directory-style submitted bundle. The standalone
backtester now owns module validation, bundle storage, sandbox execution, async
run lifecycle and result artifacts, and accepts a different compact inline
bundle.

The current arrangement has four structural problems:

1. a clean `trading-lab` clone needs a sibling backtester checkout;
2. public DTOs exist in two manually synchronized copies;
3. builder ownership still reflects the former platform-hosted backtest gateway;
4. no independently installable, versioned consumer SDK exists.

This design is grounded in the ecosystem research recorded in
`alexnikolskiy/trading-lab`, branch `docs/sdk-boundaries-distribution`, file
`docs/research/2026-06-19-sdk-boundaries-and-distribution.md`.

## 2. Goal

Ship one complete, public, standalone SDK owned by `trading-backtester`:

```text
@trading-backtester/sdk
├── /contracts
├── /builder
├── /client
└── /artifacts
```

The first release must allow an external TypeScript project to author the exact
executable bundle accepted by the backtester, validate it locally, submit it,
poll its lifecycle and read bounded result artifacts without a workspace link,
sibling checkout, registry token or dependency on `trading-platform`.

## 3. Scope

### In scope

- a new `packages/sdk` workspace package;
- one source of truth for public backtester DTOs and version constants;
- deterministic authoring helpers for the backtester's executable bundle;
- the existing typed HTTP client under an explicit subpath;
- public artifact DTOs and pure guards;
- compiled ESM and `.d.ts` output with packaged JSON Schema assets;
- Apache-2.0 licensing for the SDK;
- clean-consumer and package-content verification;
- a GitHub Release `.tgz` delivery workflow;
- a coordinated migration path for `trading-lab`;
- removal of the legacy client after consumer cutover.

### Out of scope

- LLM calls or trading-logic generation in the SDK;
- sandbox execution or authoritative validation inside the SDK;
- platform contract-017 rich manifests and platform directory bundles;
- historical-data ownership migration to `trading-platform-sdk`;
- changes to paper admission or live execution;
- npmjs or GitHub Packages publication;
- moving repositories into a GitHub Organization;
- deleting the platform builder in this slice;
- changing backtest semantics, metrics or the sandbox security policy.

## 4. Decisions

1. **One package, four explicit subpaths.** Builder, client, contracts and
   artifacts share one semver and one release asset.
2. **No compatibility wrapper.** `@trading-backtester/client` has not been
   publicly released and has one controlled external consumer. The migration is
   an intentional breaking cutover.
3. **Complete first release.** Version `0.1.0` includes all four surfaces.
4. **Exact backtester bundle.** Builder output is the compact inline executable
   `ModuleBundle` accepted by the backtester, not the platform's rich manifest.
5. **Deterministic builder only.** Strategy generation and LLM orchestration
   remain in `trading-lab`; execution remains in the backtester sandbox.
6. **Contracts become canonical.** Client and service no longer declare or
   vendor duplicate public wire DTOs.
7. **No public `@trading/research-contracts`.** Its backtester-owned public DTOs
   move into the SDK. Platform historical and engine-only types remain private
   until their own boundary is designed — with one deliberate exception: the
   momentum authoring `Candle` row *shape* (structurally the canonical reader
   row) is published because the momentum ABI hands that row to authored code.
   The reader interface, query/paging DTOs and the data API stay private.
8. **GitHub Release assets.** The package is installed by exact public `.tgz`
   URL; no npm registry is required.
9. **Apache-2.0.** The public SDK carries an explicit permissive license with a
   patent grant.
10. **One determinism core (option a).** The canonical-JSON serializer, content
    hashing and contract-number quantization move into the SDK as the single
    source of truth and are exported from `sdk/contracts` as protocol
    primitives. The service does not keep a second implementation. The existing
    `apps/backtester/src/determinism/{canonical-json,hash}.ts` files become thin
    re-export wrappers over the SDK primitives, so current service and test
    imports stay valid while the implementation is no longer duplicated.
11. **`decimal.js` is an explicit SDK runtime dependency.** The quantizer depends
    on `decimal.js`; the SDK declares it in `dependencies`. The package does not
    rely on implicit bundler inlining for correctness or for the golden-hash
    parity guarantee.
12. **`ContentHash` lives in `internal/shared-types.ts`.** It is re-exported by
    both `contracts` and `artifacts` so there is exactly one `ContentHash`
    definition and no `contracts → artifacts` import cycle.

## 5. Package architecture

```text
packages/sdk/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
├── LICENSE
├── schemas/
└── src/
    ├── index.ts
    ├── internal/
    │   ├── canonical-json.ts
    │   ├── content-hash.ts
    │   └── shared-types.ts
    ├── contracts/
    │   └── index.ts
    ├── builder/
    │   └── index.ts
    ├── client/
    │   └── index.ts
    └── artifacts/
        └── index.ts
```

`src/internal` is package-private and is not listed in `exports`. It holds
foundational definitions used by several public facades so that the package has
one definition without introducing circular subpath dependencies:

- `internal/shared-types.ts` owns `ContentHash`; `contracts` and `artifacts`
  both re-export it, so neither facade imports the other for it.
- `internal/canonical-json.ts` owns the deterministic serializer and the
  contract-number quantizer (`canonicalJson`, `quantizeContractNumber`), which
  depend on `decimal.js`.
- `internal/content-hash.ts` owns `sha256Hex`, `contentRef` and
  `canonicalBundleHash`.

These internal modules are not exported as subpaths, but the protocol
primitives they define are re-exported through `sdk/contracts` (see §7.2) as the
single source of truth shared by builder, service and tests. `decimal.js` is a
declared runtime dependency of the SDK, not an implicitly bundled import.

The dependency direction is:

```text
internal foundations
      ↑
contracts ← builder
      ↑       ↑
      └─ client
      ↑
 artifacts facade

backtester service → contracts (+ canonical bundle hashing)
```

The service depends on the SDK workspace package as the implementation of the
published contract. The SDK never imports from `apps/backtester`, storage,
workers, sandbox implementation or a platform package.

The root import exports only SDK identity and compatibility metadata. Consumers
must use explicit subpaths for operational APIs.

## 6. Contract ownership

### Public backtester-owned contracts

The following become canonical under `@trading-backtester/sdk/contracts`:

- executable `ModuleKind`, `ModuleManifest` and inline `ModuleBundle`;
- `BacktestEngine` and the two existing executable entrypoint ABIs;
- bundle/API/artifact contract version constants;
- module validation request and report;
- run submission request and idempotency fields;
- run handle, lifecycle, timeline and terminal outcome;
- result summary, metric comparison and evidence references;
- capability and dataset descriptors exposed by the backtester HTTP API;
- completion-event wire DTO;
- stable gateway error categories;
- the canonical determinism primitives (`canonicalJson`,
  `quantizeContractNumber`, `sha256Hex`, `contentRef`, `canonicalBundleHash`)
  shared by builder, service and tests.

The SDK contract is the external wire shape. Internal engine models may be
richer, but conversion happens inside the service and is not leaked through the
package.

### Contracts that remain private

The first SDK release does not publish the entire current
`@trading/research-contracts` package. These remain private:

- platform-owned `HistoricalDatasetReader`, its range/one-symbol query DTOs and
  the historical-rows-page / data-API transport DTOs;
  - **Exception:** the momentum authoring `Candle` is published in `/contracts`
    as a public authoring type. It is structurally the canonical reader row
    (`historical.ts::CanonicalRow` ≡ `ReaderRow`: `symbol`, `minute_ts`, OHLCV,
    `turnover`, and the optional OI/funding/taker columns with `has_*` flags),
    because the momentum ABI passes that exact row to untrusted authored code via
    `signals(candles, seed)`. Only this row *shape* is published — the reader
    interface, queries, paging and the data-API itself stay private;
- engine-only portfolio, execution, indicator and market-tape structures;
- internal sandbox IPC/session models;
- storage rows and job-store representations.

`packages/research-contracts` may remain temporarily as a private internal
package for these types. Backtester-owned public wire definitions are removed
from it once the service has migrated to `sdk/contracts`. Historical-data types
move only during the future `trading-platform-sdk` initiative.

## 7. Public API

### 7.1 Root

```ts
import {
  SDK_VERSION,
  SDK_CAPABILITIES,
  SUPPORTED_API_CONTRACT_VERSIONS,
} from '@trading-backtester/sdk';
```

The root has no client, builder or broad type barrel.

### 7.2 Contracts

```ts
import type {
  ModuleBundle,
  ModuleManifest,
  ModuleValidateRequest,
  RunSubmitRequest,
  RunJobHandle,
  RunStatusView,
  RunResultSummary,
  ValidationReport,
} from '@trading-backtester/sdk/contracts';
```

`contracts` also exports version constants, schema identifiers and the canonical
determinism primitives used by builder, service and tests:

```ts
import {
  canonicalJson,
  contentRef,
  sha256Hex,
  quantizeContractNumber,
  canonicalBundleHash,
} from '@trading-backtester/sdk/contracts';
```

These are the single source of truth. The service's
`apps/backtester/src/determinism/{canonical-json,hash}.ts` become thin
re-export wrappers over them (the wrapper may re-export `quantizeContractNumber`
under the service's historical name `quantize`), so existing service and golden
test imports keep working without a second implementation. `contracts` does not
expose filesystem paths or service implementation objects.

### 7.3 Builder

The public builder API is:

```ts
createModuleManifest(input): ModuleManifest
createModuleBundle({ manifest, entry, files }): ModuleBundle
computeInlineBundleHash(bundle): ContentHash
preflightValidateBundle(bundle, { engine }): ValidationReport
```

These names and responsibilities are part of the public design. The exact input
field types are derived from the canonical contract during implementation.

`computeInlineBundleHash` corresponds to the service's registry-identity hash
`apps/backtester/src/sandbox/bundle.ts::bundleHash` (`contentRef(bundle)` over
the full inline bundle) and delegates to the shared `canonicalBundleHash`
primitive. It is intentionally distinct from the service's sandbox-integrity
hash `apps/backtester/src/engine/sandbox/bundle-hash.ts::computeBundleHash`,
which reads a materialized bundle directory and hashes
`{ manifestSha256, files }`. That sandbox-integrity function keeps its name and
is not part of the SDK surface.

The first release describes both executable ABIs already implemented by the
service:

```text
engine: momentum
  entry exports named `signals` or a default function
  signals(candles, seed) -> boolean[]

engine: overlay
  entry default-exports a factory or module object
  strategy module: onBarClose required; lifecycle hooks optional
  overlay module: apply required; lifecycle hooks optional
  decision hook: (StrategyContext) -> decision | decision[] | null
```

The SDK exports TypeScript authoring types for these shapes. They are derived
explicitly from `packages/research-contracts/src/research/context.ts`
(`StrategyContext`, the bar/point-in-time shapes, and the closed decision
vocabularies) and must not pull in engine-only types — portfolio, execution,
indicator, market-tape, storage rows or sandbox IPC models stay private — with
one deliberate exception: the momentum `Candle`, the published canonical
reader-row shape (see §6). The hook-facing indicator and point-in-time market
*interface* types that `StrategyContext` exposes (`IndicatorApi`,
`PointInTimeMarketApi` and their point/reading types) are published; the
indicator catalog/validation and market-tape dataset/builder/coverage types are
not. The
selected `RunSubmitRequest.engine` determines which ABI authoritative validation
and the sandbox use. Preflight receives the same engine explicitly and checks manifest,
layout and declared ABI compatibility. It does not import the entrypoint and
therefore cannot claim that a required runtime export really exists.

The behavioral contract is:

- all functions are synchronous, pure and deterministic;
- the caller supplies generated source code and metadata;
- file paths are normalized and traversal/absolute paths are rejected;
- canonical file ordering is independent of object insertion order;
- identical semantic input produces the same canonical hash;
- validation issues are sorted by stable `(path, code)` ordering;
- preflight performs structural, version, path and declared-ABI checks only;
- preflight never imports or executes submitted source;
- preflight issue codes are a subset compatible with authoritative service
  validation (e.g. `bundle_entrypoint_invalid`, `unsupported_contract_version`,
  `unsupported_module_kind`); it does not invent new codes such as
  `bundle_path_invalid`.

The builder does not create platform contract-017 manifests, call an LLM,
generate trading rules, read a bundle directory, contact a service or run a
sandbox.

### 7.4 Client

```ts
const client = new BacktesterClient({ baseUrl, token, fetchImpl });

await client.getCapabilities();
await client.listDatasets();
await client.validateModule(request);
await client.submitRun(request);
await client.getRunStatus(runId);
await client.getRunResult(runId);
await client.getArtifactManifest(runId);
await client.readArtifact(runId, artifactId, options);
await client.cancelRun(runId);
await client.awaitCompletion(runId, options);
```

The client owns HTTP construction, bearer auth, JSON parsing and typed error
mapping. It does not redeclare contract or artifact types. `fetchImpl` remains
injectable and global `fetch` remains the default. `awaitCompletion` (poll until
terminal, with injectable `sleep`/timeout) is preserved from the existing client
so the current `trading-lab` adapter keeps its polling helper.

### 7.5 Artifacts

The artifacts facade exports:

- `ContentHash` and content-hash guards;
- availability vocabulary;
- artifact reference, descriptor, manifest and page DTOs;
- pure validation/narrowing helpers.

Artifact retrieval remains a client responsibility. The SDK provides no direct
blob-store/filesystem access and no helper that reads a complete unbounded raw
artifact.

## 8. Validation and error behavior

Local builder preflight and service validation have deliberately different
authority:

```text
builder preflight
  → cheap structural rejection and author feedback
service validation
  → authoritative schemas, import scan, policy and sandbox boundary
```

A successful local preflight does not promise that authoritative validation or
execution will succeed.

Builder validation returns a stable report for user-controlled invalid input.
Programmer/configuration errors may throw typed SDK errors, but validation must
not leak arbitrary Node filesystem or parser exceptions.

The client maps HTTP failures into the existing typed categories:

- validation;
- authentication;
- not found;
- conflict/idempotency;
- generic backtester error.

Unsupported contract versions fail before enqueue. Server error payloads remain
the authority for terminal failure codes. The SDK does not convert a failed or
timed-out run into a successful empty result.

## 9. Build and package contents

The SDK builds to standalone ESM JavaScript and declarations. Its tarball
contains only:

- compiled `dist` entrypoints;
- `.d.ts` declarations;
- required JSON Schema assets;
- `package.json`;
- README;
- Apache-2.0 LICENSE.

The tarball must not contain:

- `src` or tests;
- workspace links or `file:../...` dependencies;
- `apps/backtester` implementation;
- sandbox harness/images;
- platform internals;
- credentials, `.env` files or generated run artifacts.

Multiple tsup entrypoints produce the four subpath exports. Schema assets are
copied or generated as part of the package build and must resolve from an
installed tarball, not from the repository layout.

The SDK declares `decimal.js` as its sole runtime `dependency` (it backs the
canonical-number quantizer). A clean consumer installs it transitively from the
public registry. The package does not rely on implicit tsup bundling of
`decimal.js`; package inspection allows this one declared registry dependency
while still rejecting any `workspace:`, `file:` or `link:` specifier.

## 10. Distribution

The first release is attached to a public GitHub Release:

```text
tag:    sdk-v0.1.0
asset:  trading-backtester-sdk-0.1.0.tgz
```

A consumer pins the exact asset URL:

```json
{
  "dependencies": {
    "@trading-backtester/sdk": "https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.1.0/trading-backtester-sdk-0.1.0.tgz"
  }
}
```

Package naming does not depend on npmjs scope ownership because no npm registry
is used. Public consumers need no GitHub token.

The release workflow performs:

```text
typecheck and tests
→ build
→ clean-consumer install/import
→ npm pack inspection
→ SHA-256 checksum and source manifest
→ tag/release creation
→ asset upload
```

Published assets are immutable by policy. A workflow refuses to overwrite an
existing tag or asset. Any correction receives a new semver version.

A future transfer into a GitHub Organization is a repository-governance task,
not part of SDK implementation. The ecosystem should remain multiple repositories
under one organization rather than becoming a single source monorepo.

## 11. Migration sequence

### Phase 1: create and release the SDK

In `trading-backtester`:

1. add the full `packages/sdk` package;
2. move canonical public wire definitions into `sdk/contracts`;
3. implement deterministic builder and artifact facades;
4. move the HTTP client implementation into `sdk/client`;
5. convert service imports to canonical SDK contracts;
6. add package/release verification;
7. publish `sdk-v0.1.0` after approval.

The existing `packages/client` remains frozen during this phase so the current
`trading-lab/main` path dependency does not break. It is not changed into a
wrapper and receives no new API.

### Phase 2: consumer cutover

In a separate `trading-lab` spec and PR:

1. replace the sibling client dependency with the exact release asset URL;
2. change imports to `/client`, `/contracts`, `/builder` and `/artifacts`;
3. remove `toBacktesterBundle` translation where the lab builder can directly
   produce the canonical executable bundle;
4. stop using `@trading-platform/sdk/builder` on the backtester path;
5. run the cross-repository demo and contract gates.

This cutover is scheduled around the independent Conversational Operator
roadmap. Meaningful completion replies, reranking, Phoenix and strip-types work
may proceed in parallel. Bot catalog waits for platform SDK identity DTOs;
Artifact RAG waits for the stable SDK artifact API.

### Phase 3: legacy removal

After the consumer cutover is merged:

- remove `packages/client`;
- remove `packages/client/src/wire.ts` and the client parity test;
- remove backtester-owned duplicate wire definitions from the private contracts
  package;
- update Dockerfiles, README, AGENTS and operations documentation;
- add a guard rejecting production sibling `file:../...` dependencies.

The platform builder is removed only after the separate public
`trading-platform-sdk` migration confirms no remaining consumers.

## 12. Verification strategy

### Unit tests

- manifest and bundle construction;
- unsafe path rejection;
- canonical ordering and stable hash;
- validation issue ordering and error taxonomy;
- content-hash guards;
- client request/response/error mapping.

### Contract tests

- service handlers accept SDK requests and return SDK responses;
- service and SDK compute the same golden inline bundle hash
  (`computeInlineBundleHash` ≡ `sandbox/bundle.ts::bundleHash`);
- the service determinism wrappers and the SDK primitives produce byte-identical
  output (existing golden `result_hash` / fingerprint snapshots stay frozen);
- authoritative validation consumes packaged schemas;
- the SDK `API_CONTRACT_VERSION` and the private package's `CONTRACT_VERSION`
  are asserted value-equal (`017.2`) while the two coexist;
- the boundary guard distinguishes public SDK DTOs from private engine models:
  it forbids public wire imports from the old package on boundary files while
  still allowing `HistoricalDatasetReader`, canonical rows, engine profiles and
  sandbox IPC types to be imported from the private package;
- all lifecycle and terminal statuses are exhaustively covered;
- artifact result references match the artifact facade.

### Integration tests

- `BacktesterClient` against a real in-process HTTP app;
- module validation, submit, poll, result and artifact page flow;
- both in-memory and PostgreSQL store suites remain green;
- sandbox security and deterministic `result_hash` tests remain unchanged.

### Package tests

A temporary consumer outside the pnpm workspace must:

1. install the freshly packed `.tgz` with a frozen lock;
2. typecheck imports from root and all four subpaths;
3. execute ESM imports;
4. build and hash a fixture bundle (`computeInlineBundleHash`);
5. call `allSchemaAssets()` and assert all five 017 schema assets resolve from
   the installed tarball (not the repository layout);
6. use the client against the fixture HTTP app or a controlled test server.

Package inspection fails on workspace/file links, forbidden files, platform
implementation references or missing schema assets.

### Cross-repository acceptance

After the `trading-lab` cutover:

```text
trading-lab
  → @trading-backtester/sdk
  → trading-backtester
  → trading-mock-platform data API
  → completed deterministic result and bounded artifacts
```

## 13. Security invariants

- research-only: no live-order execution API;
- no exchange credentials or exchange adapter imports;
- no direct market ingestion;
- submitted code is never executed by builder/client;
- authoritative execution remains in the locked sandbox;
- no weakening of network, capability, filesystem, CPU, memory or PID sandbox
  limits;
- artifacts remain bounded and paginated;
- deterministic hashing never includes wall-clock or random state.

## 14. Acceptance criteria

The SDK initiative is complete when:

1. `@trading-backtester/sdk@0.1.0` exposes all four documented subpaths;
2. the packed tarball installs and runs outside the workspace;
3. service, builder and client share one canonical public contract source, and
   one determinism core (canonical JSON, quantizer, content hashing) with the
   service consuming it via thin re-export wrappers and `decimal.js` declared as
   an SDK runtime dependency;
4. builder emits the exact inline executable bundle accepted by the service;
5. SDK and service produce identical golden inline bundle hashes, and existing
   frozen `result_hash`/fingerprint goldens stay byte-identical;
6. the package has no sibling/workspace/platform implementation dependency;
7. GitHub Release assets include `.tgz`, checksum and source manifest;
8. `trading-lab` installs without `../trading-backtester` after its cutover;
9. the legacy client is removed after that cutover, without a wrapper;
10. full unit, integration, storage, sandbox and cross-repository gates pass;
11. research-only and sandbox security invariants remain intact.
