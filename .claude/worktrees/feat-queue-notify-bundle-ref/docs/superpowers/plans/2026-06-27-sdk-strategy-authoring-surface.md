# SDK strategy-authoring-surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strategy-authoring surface to `@trading-backtester/sdk` (authoring doc + worked `createStrategyModule` example with entry+management, `getAuthoringDoc(kind)`, `scaffoldStrategyBundle`, `computeBundleHash` raw-bytes pin) on top of a breaking `./builder` rewrite that single-sources the rich kernel manifest.

**Architecture:** The SDK re-sources the rich `ModuleManifest` from the platform kernel (`@trading-platform/sdk/research-contract`) and wraps it as a bundle-layer `BundleManifest` (kernel manifest + `bundleContractVersion`). The `./builder` subpath grows an `authoring/` directory holding the versioned doc, worked self-contained ESM examples for both module kinds, and a one-call scaffold helper. No new package export — everything ships through the existing `./builder` entry.

**Tech Stack:** TypeScript (ESM, `node22` target), tsup (bundling), api-extractor (dts rollup), vitest (tests), the kernel `@trading-platform/sdk` (bundled via `noExternal`).

## Global Constraints

- `bundleContractVersion` MUST equal `019.1` (`BUNDLE_CONTRACT_VERSION`, `src/internal/versions.ts`); `contractVersion` MUST equal `017.2` (`API_CONTRACT_VERSION`).
- Worked example bundles MUST be self-contained ESM: **no `import`/`require`**, pre-built JS, `export default function createStrategyModule(params)` (FR-003). Deterministic — only `ctx`; no `Date.now()`/`Math.random()`.
- Two hashes, never conflated: `computeBundleHash(rawBytes)` = sha256 of raw ESM bytes (`'sha256:<hex>'`, cross-boundary pin); `computeInlineBundleHash(bundle)` = structural canonical-JSON hash (backtester-internal identity).
- Canonical bundle contract = the SDK contract (`{ id, version, kind, bundleContractVersion }` + rich kernel fields). Do NOT change the runtime contract or the `export default createStrategyModule` entry convention.
- Re-source kernel types by RELATIVE import only where existing code does; the public SDK package keeps its `@trading-platform/sdk` devDependency (already bundled via `noExternal`).
- Scope-out (documented follow-up, do NOT do here): unifying `packages/research-contracts`'s own `ModuleBundle`/`BUNDLE_CONTRACT_VERSION`; the app sandbox tests `sandbox.test.ts`, `sandbox-failure.test.ts`, `validation-reject.test.ts` import bundle types from `@trading/research-contracts` and are unaffected — leave them.

---

### Task 1: R2 foundation — single-source kernel manifest + migrate all SDK-facing consumers

Breaking rewrite of the manifest layer. End state: the whole workspace type-checks and every test
suite is green on the rich manifest. No authoring features yet.

**Files:**
- Modify: `packages/sdk/src/contracts/module.ts`
- Modify: `packages/sdk/src/builder/manifest.ts`
- Modify: `packages/sdk/test/builder.test.ts`
- Modify: `scripts/verify-sdk-clean-consumer.ts`
- Modify: `apps/backtester/test/bundle.test.ts`
- Modify: `packages/sdk/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `packages/sdk/package.json`

**Interfaces:**
- Produces: `BundleManifest` (kernel `ModuleManifest` + `bundleContractVersion`); `ModuleBundle.manifest: BundleManifest`; `createModuleManifest(input: CreateModuleManifestInput): BundleManifest` with the rich input below; re-exported kernel types `ModuleKind`, `ModuleManifest`, `LifecycleHook`, `CapabilityDeclaration`, `DataNeedsDeclaration`, `Author`, `ModuleStatus`.

- [ ] **Step 1: Rewrite `packages/sdk/src/contracts/module.ts`**

```typescript
// Module contract types. The rich module manifest is re-sourced from the platform kernel
// (@trading-platform/sdk/research-contract) — single source, no drift (the path 042 took for the
// 017 contracts). The bundle layer adds `bundleContractVersion` on top of the kernel manifest.
export type {
  Author,
  CapabilityDeclaration,
  DataNeedsDeclaration,
  LifecycleHook,
  ModuleKind,
  ModuleManifest,
  ModuleStatus,
} from '@trading-platform/sdk/research-contract';

import type { ModuleManifest } from '@trading-platform/sdk/research-contract';

export type BacktestEngine = 'momentum' | 'overlay';

/**
 * Bundle-layer manifest: the kernel module manifest plus the SDK bundle-wire-format version.
 * `bundleContractVersion` is a bundling concern the kernel does not own. It is DISTINCT from the
 * kernel's `contractVersion` (the 017 research-contract version) — do not conflate the two.
 */
export interface BundleManifest extends ModuleManifest {
  readonly bundleContractVersion: string;
}

export interface ModuleBundle {
  readonly manifest: BundleManifest;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}
```

- [ ] **Step 2: Rewrite `packages/sdk/src/builder/manifest.ts`**

```typescript
import type {
  Author,
  BundleManifest,
  CapabilityDeclaration,
  DataNeedsDeclaration,
  LifecycleHook,
  ModuleKind,
  ModuleStatus,
} from '../contracts/module';
import { API_CONTRACT_VERSION, BUNDLE_CONTRACT_VERSION } from '../internal/versions';

export interface CreateModuleManifestInput {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly summary: string;
  readonly rationale: string;
  readonly hooks: readonly LifecycleHook[];
  readonly paramsSchema: object;
  readonly capabilities: CapabilityDeclaration;
  readonly dataNeeds: DataNeedsDeclaration;
  readonly author?: Author;
  readonly status?: ModuleStatus;
  readonly params?: object;
  readonly source?: string;
  readonly targetStrategyRef?: string;
  readonly interceptionPoint?: string;
}

/**
 * Build a frozen bundle-layer manifest: the rich kernel manifest with `contractVersion` and
 * `bundleContractVersion` pinned to the SDK's contract constants. Pure: same input => structurally
 * identical manifest. `author` defaults to 'agent', `status` to 'research_only'.
 */
export function createModuleManifest(input: CreateModuleManifestInput): BundleManifest {
  return Object.freeze({
    id: input.id,
    version: input.version,
    kind: input.kind,
    name: input.name,
    summary: input.summary,
    rationale: input.rationale,
    author: input.author ?? 'agent',
    status: input.status ?? 'research_only',
    contractVersion: API_CONTRACT_VERSION,
    paramsSchema: input.paramsSchema,
    ...(input.params !== undefined ? { params: input.params } : {}),
    capabilities: input.capabilities,
    dataNeeds: input.dataNeeds,
    hooks: input.hooks,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.targetStrategyRef !== undefined ? { targetStrategyRef: input.targetStrategyRef } : {}),
    ...(input.interceptionPoint !== undefined ? { interceptionPoint: input.interceptionPoint } : {}),
    bundleContractVersion: BUNDLE_CONTRACT_VERSION,
  });
}
```

- [ ] **Step 3: Rewrite `packages/sdk/test/builder.test.ts` to the rich API (failing first)**

```typescript
import { describe, expect, it } from 'vitest';
import {
  computeInlineBundleHash,
  createModuleBundle,
  createModuleManifest,
  preflightValidateBundle,
} from '../src/builder/index';
import { BUNDLE_CONTRACT_VERSION, API_CONTRACT_VERSION } from '../src/internal/versions';

const manifestInput = {
  id: 'overlay-1',
  version: '1.0.0',
  kind: 'overlay' as const,
  name: 'Overlay one',
  summary: 's',
  rationale: 'r',
  hooks: ['apply'] as const,
  paramsSchema: { type: 'object' },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
};

describe('SDK builder', () => {
  it('createModuleManifest pins versions and defaults author/status', () => {
    const m = createModuleManifest(manifestInput);
    expect(m.bundleContractVersion).toBe(BUNDLE_CONTRACT_VERSION);
    expect(m.contractVersion).toBe(API_CONTRACT_VERSION);
    expect(m.author).toBe('agent');
    expect(m.status).toBe('research_only');
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('createModuleBundle is deterministic and order-independent', () => {
    const manifest = createModuleManifest(manifestInput);
    const a = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'x', 'a.js': 'y' } });
    const b = createModuleBundle({ manifest, entry: 'i.js', files: { 'a.js': 'y', 'i.js': 'x' } });
    expect(computeInlineBundleHash(a)).toBe(computeInlineBundleHash(b));
  });

  it('preflight accepts a well-formed overlay bundle for the overlay engine', () => {
    const manifest = createModuleManifest(manifestInput);
    const bundle = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'export default () => ({ apply: () => null })' } });
    const report = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(report.status).toBe('accepted');
  });

  it('preflight rejects an entry not in files', () => {
    const manifest = createModuleManifest(manifestInput);
    const bundle = createModuleBundle({ manifest, entry: 'missing.js', files: { 'i.js': 'x' } });
    const report = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
```

- [ ] **Step 4: Run the SDK builder test — expect FAIL (createModuleManifest still minimal)**

Run: `pnpm --filter @trading-backtester/sdk test -- builder`
Expected: FAIL — `createModuleManifest` type error / missing rich fields (Steps 1–2 not yet picked up if run before save). After Steps 1–2 are saved, re-run.

- [ ] **Step 5: Run the SDK builder test — expect PASS**

Run: `pnpm --filter @trading-backtester/sdk test -- builder`
Expected: PASS (4 tests).

- [ ] **Step 6: Migrate `scripts/verify-sdk-clean-consumer.ts`**

Replace the minimal `createModuleManifest({ id: 'smoke', version: '1.0.0', kind: 'overlay' })` call (around line 50) with the rich form:

```typescript
const manifest = createModuleManifest({
  id: 'smoke',
  version: '1.0.0',
  kind: 'overlay',
  name: 'Smoke overlay',
  summary: 'clean-consumer smoke',
  rationale: 'verifies the published SDK builds bundles standalone',
  hooks: ['apply'],
  paramsSchema: { type: 'object' },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});
```

(The rest of the script — `createModuleBundle`, `computeInlineBundleHash`, `isContentHash` — is unchanged.)

- [ ] **Step 7: Migrate `apps/backtester/test/bundle.test.ts` to SDK contracts + rich manifest**

Change the imports so the bridged byte-parity test uses the SDK's `ModuleBundle`/`BUNDLE_CONTRACT_VERSION` (the service `bundleHash`/`validateBundle` already take the SDK `ModuleBundle`), and build a rich manifest via the SDK builder:

```typescript
import { describe, expect, it } from 'vitest';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';
import { computeInlineBundleHash, createModuleManifest } from '@trading-backtester/sdk/builder';
import { bundleHash, validateBundle } from '../src/sandbox/bundle';

const SRC = 'export function signals(c){ return c.map(()=>false); }';

const MANIFEST = createModuleManifest({
  id: 'b',
  version: '1.0.0',
  kind: 'strategy',
  name: 'Byte-parity fixture',
  summary: 's',
  rationale: 'r',
  hooks: ['onBarClose'],
  paramsSchema: { type: 'object' },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});

function bundle(over: Partial<ModuleBundle> = {}): ModuleBundle {
  return { manifest: MANIFEST, entry: 'module.mjs', files: { 'module.mjs': SRC }, ...over };
}
```

Leave the test bodies unchanged EXCEPT the `bundleContractVersion: '000.0'` case, which now spreads
the rich manifest:

```typescript
  it('rejects an unsupported contract version', () => {
    const issues = validateBundle(bundle({ manifest: { ...MANIFEST, bundleContractVersion: '000.0' } }));
    expect(issues.some((i) => i.code === 'unsupported_contract_version')).toBe(true);
  });
```

And the overlay/unsupported-kind cases keep using `{ ...MANIFEST, kind: ... as never }`.

- [ ] **Step 8: Update `packages/sdk/README.md` and `docs/ARCHITECTURE.md`**

In `packages/sdk/README.md` (the `createModuleManifest` example, ~line 61) replace the minimal input
with the rich input (same shape as Step 6). In `docs/ARCHITECTURE.md` (line 71) keep the `/builder`
row but append the new exports: `getAuthoringDoc`, `STRATEGY_AUTHORING_DOC`, `STRATEGY_EXAMPLE_BUNDLE`,
`computeBundleHash`, `scaffoldStrategyBundle` (these land in later tasks; documenting them now keeps
the table the single source — acceptable since the table is prose, not code).

- [ ] **Step 9: Bump SDK version**

In `packages/sdk/package.json` change `"version": "0.2.1"` to `"version": "0.3.0"` (breaking).
Also update the `SDK_VERSION` constant in `packages/sdk/src/internal/versions.ts` from `'0.2.1'` to
`'0.3.0'`.

- [ ] **Step 10: Type-check + full test sweep**

Run: `pnpm -r typecheck && pnpm --filter @trading-backtester/sdk test && pnpm --filter backtester test -- bundle && pnpm tsx scripts/verify-sdk-clean-consumer.ts`
Expected: all green. (The non-bridged app sandbox tests use `@trading/research-contracts` and are untouched.)

- [ ] **Step 11: Commit**

```bash
git add packages/sdk/src/contracts/module.ts packages/sdk/src/builder/manifest.ts packages/sdk/test/builder.test.ts scripts/verify-sdk-clean-consumer.ts apps/backtester/test/bundle.test.ts packages/sdk/README.md docs/ARCHITECTURE.md packages/sdk/package.json packages/sdk/src/internal/versions.ts
git commit -m "feat(sdk)!: single-source kernel ModuleManifest as BundleManifest

BREAKING: ModuleBundle.manifest is now the rich kernel manifest +
bundleContractVersion. createModuleManifest takes the rich input. SDK 0.3.0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `hash.ts` — raw-bytes `computeBundleHash` + extract `computeInlineBundleHash`

**Files:**
- Modify: `packages/sdk/src/internal/content-hash.ts`
- Create: `packages/sdk/src/builder/hash.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/builder-hash.test.ts`

**Interfaces:**
- Consumes: `canonicalBundleHash` (`internal/content-hash`), `ContentHash` (`internal/shared-types`), `ModuleBundle` (`contracts/module`).
- Produces: `computeInlineBundleHash(bundle: ModuleBundle): ContentHash`; `computeBundleHash(rawBytes: Buffer | Uint8Array): ContentHash`; `sha256HexBytes(input: Uint8Array): string`.

- [ ] **Step 1: Write the failing test `packages/sdk/test/builder-hash.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { computeBundleHash, computeInlineBundleHash, createModuleBundle, createModuleManifest } from '../src/builder/index';

const manifest = createModuleManifest({
  id: 'h', version: '1.0.0', kind: 'strategy', name: 'n', summary: 's', rationale: 'r',
  hooks: ['onBarClose'], paramsSchema: { type: 'object' }, capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});

describe('builder hashes', () => {
  it('computeBundleHash hashes raw bytes to sha256:<hex>', () => {
    const h = computeBundleHash(Buffer.from('export default () => ({})', 'utf8'));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('computeBundleHash is byte-stable across Buffer and Uint8Array', () => {
    const bytes = new TextEncoder().encode('payload');
    expect(computeBundleHash(bytes)).toBe(computeBundleHash(Buffer.from('payload', 'utf8')));
  });

  it('computeInlineBundleHash is structural and distinct from the raw-bytes hash', () => {
    const bundle = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'x' } });
    const structural = computeInlineBundleHash(bundle);
    const raw = computeBundleHash(Buffer.from('x', 'utf8'));
    expect(structural).toMatch(/^sha256:/);
    expect(structural).not.toBe(raw);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @trading-backtester/sdk test -- builder-hash`
Expected: FAIL — `computeBundleHash` is not exported.

- [ ] **Step 3: Add `sha256HexBytes` to `packages/sdk/src/internal/content-hash.ts`**

Add below the existing `sha256Hex`:

```typescript
export function sha256HexBytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
```

- [ ] **Step 4: Create `packages/sdk/src/builder/hash.ts`**

```typescript
import type { ContentHash } from '../internal/shared-types';
import type { ModuleBundle } from '../contracts/module';
import { canonicalBundleHash, sha256HexBytes } from '../internal/content-hash';

/**
 * Internal structural identity (backtester sandbox-registry only): hashes the canonical JSON of
 * `{ manifest, entry, files }`. Same bundle => same hash. Distinct from the engine's
 * sandbox-integrity `computeBundleHash`, which hashes a materialized bundle directory.
 */
export function computeInlineBundleHash(bundle: ModuleBundle): ContentHash {
  return canonicalBundleHash(bundle);
}

/**
 * Cross-boundary pin: sha256 over the RAW ESM bytes, returns 'sha256:<hex>'. This is the hash that
 * goes into evidence.bundleHash and the platform bot_bundle.contentHash. It deliberately accepts
 * ONLY raw bytes (not a ModuleBundle) so it cannot be confused with computeInlineBundleHash.
 */
export function computeBundleHash(rawBytes: Buffer | Uint8Array): ContentHash {
  return `sha256:${sha256HexBytes(rawBytes)}`;
}
```

- [ ] **Step 5: Rewrite `packages/sdk/src/builder/index.ts` as a pure barrel (move `computeInlineBundleHash` out)**

```typescript
export { createModuleManifest } from './manifest';
export type { CreateModuleManifestInput } from './manifest';
export { createModuleBundle } from './bundle';
export type { CreateModuleBundleInput } from './bundle';
export { preflightValidateBundle, type PreflightOptions } from './preflight';
export { computeInlineBundleHash, computeBundleHash } from './hash';
```

(Authoring exports are appended in Tasks 3–6.)

- [ ] **Step 6: Run — expect PASS**

Run: `pnpm --filter @trading-backtester/sdk test -- builder-hash`
Expected: PASS (3 tests). Also re-run `pnpm --filter @trading-backtester/sdk test -- builder` and `pnpm --filter backtester test -- bundle` — still green (byte-parity import unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/internal/content-hash.ts packages/sdk/src/builder/hash.ts packages/sdk/src/builder/index.ts packages/sdk/test/builder-hash.test.ts
git commit -m "feat(sdk): computeBundleHash raw-bytes cross-boundary pin + extract hash.ts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `authoring/doc.ts` — versioned doc + `getAuthoringDoc(kind)`

**Files:**
- Create: `packages/sdk/src/builder/authoring/doc.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/authoring-doc.test.ts`

**Interfaces:**
- Consumes: `ModuleKind` (`contracts/module`).
- Produces: `AUTHORING_DOC_VERSION: string`; `STRATEGY_AUTHORING_DOC: string`; `OVERLAY_AUTHORING_DOC: string`; `getAuthoringDoc(kind: ModuleKind): string`.

- [ ] **Step 1: Write the failing test `packages/sdk/test/authoring-doc.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { AUTHORING_DOC_VERSION, getAuthoringDoc, OVERLAY_AUTHORING_DOC, STRATEGY_AUTHORING_DOC } from '../src/builder/index';

describe('authoring docs', () => {
  it('exposes a version', () => {
    expect(AUTHORING_DOC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('strategy doc documents the entry convention and both phases', () => {
    expect(STRATEGY_AUTHORING_DOC).toContain('export default function createStrategyModule');
    expect(STRATEGY_AUTHORING_DOC).toContain('onBarClose');
    expect(STRATEGY_AUTHORING_DOC).toContain('onPositionBar');
    expect(STRATEGY_AUTHORING_DOC).toContain('bundleContractVersion');
  });

  it('overlay doc documents apply + OverlayDecision', () => {
    expect(OVERLAY_AUTHORING_DOC).toContain('apply');
    expect(OVERLAY_AUTHORING_DOC).toContain('veto');
  });

  it('getAuthoringDoc dispatches by kind', () => {
    expect(getAuthoringDoc('strategy')).toBe(STRATEGY_AUTHORING_DOC);
    expect(getAuthoringDoc('overlay')).toBe(OVERLAY_AUTHORING_DOC);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @trading-backtester/sdk test -- authoring-doc`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/sdk/src/builder/authoring/doc.ts`**

```typescript
import type { ModuleKind } from '../../contracts/module';

/** Bumped whenever the authoring contract (forms/fields/conventions) changes. */
export const AUTHORING_DOC_VERSION = '1.0.0';

export const STRATEGY_AUTHORING_DOC = `# Authoring a strategy bundle

A strategy bundle is a single **self-contained ESM** file. It must:

- \`export default function createStrategyModule(params)\` returning a \`StrategyModule\`.
- Use **no** \`import\`/\`require\` — pre-built JS only (FR-003). V8 executes it directly.
- Be **deterministic** — read only \`ctx\`; never use \`Date.now()\` or \`Math.random()\`
  (use \`ctx.clock.now()\` and \`ctx.rng.next()\`).

## StrategyModule

\`\`\`
{ manifest, init?, onBarClose, onPositionBar?, onPendingIntentBar?, dispose? }
\`\`\`

\`onBarClose\` is the only required hook.

## Lifecycle phases

- **Flat phase — \`onBarClose(ctx)\`**: runs every closed bar while there is no position.
  Return an \`enter\` decision to open a position, or \`idle\`.
- **Management phase — \`onPositionBar(ctx)\`**: runs every bar while a position is open
  (\`ctx.position\` is non-null). Return \`exit\`, \`add_to_position\`, \`update_protection\`,
  \`annotate\`, or \`idle\`.

## StrategyContext (read-only, deep-frozen)

- \`ctx.bar\`: \`{ ts, open, high, low, close, volume }\` — the just-closed bar.
- \`ctx.position\`: \`{ side, size, entryPrice, stop?, take? } | null\`.
- \`ctx.data.closedCandles(lookback)\`: closed bars strictly before the current bar (as-of).
- \`ctx.data.indicatorAsOf(name)\`: scalar indicator as-of, or undefined in warmup.
- \`ctx.indicators.query({ name, params?, source? })\`: per-bar indicator value, undefined in warmup.
- \`ctx.market?\`: point-in-time open interest / liquidations / funding / taker flow (present only
  when the tape carries that data).
- \`ctx.params\`: the manifest \`params\` payload.
- \`ctx.clock.now()\`, \`ctx.rng.next()\`: deterministic clock + seeded RNG.

## Decision forms (StrategyDecision)

- \`{ kind: 'enter', side: 'long'|'short', stop?, take?, ttl?, sizingHint?, tags?, rationale? }\`
- \`{ kind: 'exit', target: string, percent?, reason? }\`
- \`{ kind: 'add_to_position', mode: 'dca'|'scale_in', sizingHint? }\`
- \`{ kind: 'update_protection', stop?, take? }\`
- \`{ kind: 'annotate', tags?, metrics?, rationale? }\`
- \`{ kind: 'idle' }\`

A hook may return one decision, an array of decisions, or null (treated as idle).

## Manifest

\`\`\`
{
  id, version, kind: 'strategy', name, summary, rationale,
  author: 'agent'|'human', status: 'research_only',
  contractVersion: '017.2', bundleContractVersion: '019.1',
  hooks: ['onBarClose', 'onPositionBar'],
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true, ... },
  capabilities: { platformSdk: true },
  paramsSchema: { /* JSON Schema of params */ },
  params: { /* default params */ }
}
\`\`\`

The bundle wraps the manifest + entry + files; \`bundleHash\` is the sha256 of the raw ESM bytes.
`;

export const OVERLAY_AUTHORING_DOC = `# Authoring an overlay (hypothesis) bundle

An overlay intervenes at exactly one point in a base strategy via the \`apply\` hook. Like a
strategy bundle it is a self-contained ESM with \`export default function createStrategyModule(params)\`,
but the returned module is \`{ manifest, init?, apply }\`.

## apply(ctx)

Runs at the overlay's interception point. Returns an \`OverlayDecision\`:

- \`{ kind: 'pass' }\` — leave the base decision unchanged.
- \`{ kind: 'veto', reasonCode: string, rationale? }\` — terminal for the current base decision.
- \`{ kind: 'patch', patch: object }\` — structural patch over the base decision (stays schema-valid).
- \`{ kind: 'annotate', tags?, notes? }\` — metadata only.

## Manifest

Same shape as a strategy, with \`kind: 'overlay'\`, \`hooks: ['apply']\`, and (optionally)
\`targetStrategyRef\` + \`interceptionPoint\`.
`;

/** Return the authoring doc for a module kind. */
export function getAuthoringDoc(kind: ModuleKind): string {
  return kind === 'overlay' ? OVERLAY_AUTHORING_DOC : STRATEGY_AUTHORING_DOC;
}
```

- [ ] **Step 4: Append authoring-doc exports to `packages/sdk/src/builder/index.ts`**

```typescript
export {
  AUTHORING_DOC_VERSION,
  getAuthoringDoc,
  OVERLAY_AUTHORING_DOC,
  STRATEGY_AUTHORING_DOC,
} from './authoring/doc';
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @trading-backtester/sdk test -- authoring-doc`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/builder/authoring/doc.ts packages/sdk/src/builder/index.ts packages/sdk/test/authoring-doc.test.ts
git commit -m "feat(sdk): strategy + overlay authoring docs and getAuthoringDoc(kind)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Worked strategy example (source + bundle) + execution test

**Files:**
- Create: `packages/sdk/src/builder/authoring/examples/strategy-example.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/strategy-example.test.ts`

**Interfaces:**
- Consumes: `createModuleManifest`, `createModuleBundle` (builder); `ModuleBundle` (contracts).
- Produces: `STRATEGY_EXAMPLE_SOURCE: string`; `STRATEGY_EXAMPLE_BUNDLE: ModuleBundle`.

- [ ] **Step 1: Write the failing test `packages/sdk/test/strategy-example.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { preflightValidateBundle, STRATEGY_EXAMPLE_BUNDLE, STRATEGY_EXAMPLE_SOURCE } from '../src/builder/index';

async function loadFactory(source: string): Promise<(p?: unknown) => any> {
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  const mod = await import(/* @vite-ignore */ url);
  return mod.default;
}

function makeCtx(over: Record<string, unknown> = {}) {
  const history = Array.from({ length: 20 }, (_, i) => ({ ts: i, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
  return {
    run: { runId: 'r', mode: 'test', seed: 1 },
    params: { lookback: 20, breakoutPct: 5, rsiPeriod: 14, rsiMax: 70, takePct: 10, stopPct: 5, dcaDrawdownPct: 3 },
    symbol: 'BTCUSDT',
    bar: { ts: 20, open: 100, high: 107, low: 100, close: 106, volume: 2000 },
    position: null,
    pendingIntent: null,
    portfolio: { equity: 1000, openPositions: 0 },
    clock: { now: () => 0 },
    data: { closedCandles: (n: number) => history.slice(-n), indicatorAsOf: () => undefined },
    indicators: { value: () => undefined, query: () => 50 },
    rng: { next: () => 0.5 },
    ...over,
  };
}

describe('strategy worked example', () => {
  it('passes preflight for the momentum engine', () => {
    const report = preflightValidateBundle(STRATEGY_EXAMPLE_BUNDLE, { engine: 'momentum' });
    expect(report.status).toBe('accepted');
  });

  it('manifest declares both lifecycle hooks', () => {
    expect(STRATEGY_EXAMPLE_BUNDLE.manifest.hooks).toEqual(['onBarClose', 'onPositionBar']);
  });

  it('onBarClose enters long on a breakout (deterministic)', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const d1 = mod.onBarClose(makeCtx());
    const d2 = mod.onBarClose(makeCtx());
    expect(d1).toEqual(d2);
    expect(d1.kind).toBe('enter');
    expect(d1.side).toBe('long');
  });

  it('onBarClose idles below the breakout threshold', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const d = mod.onBarClose(makeCtx({ bar: { ts: 20, open: 100, high: 101, low: 100, close: 101, volume: 2000 } }));
    expect(d.kind).toBe('idle');
  });

  it('onPositionBar exits at the take threshold', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const ctx = makeCtx({ position: { side: 'long', size: 1, entryPrice: 100 }, bar: { ts: 21, open: 110, high: 112, low: 109, close: 111, volume: 2000 } });
    const d = mod.onPositionBar(ctx);
    expect(d.kind).toBe('exit');
  });

  it('onPositionBar DCAs on a moderate drawdown', async () => {
    const factory = await loadFactory(STRATEGY_EXAMPLE_SOURCE);
    const mod = factory();
    const ctx = makeCtx({ position: { side: 'long', size: 1, entryPrice: 100 }, bar: { ts: 21, open: 97, high: 98, low: 96, close: 96.5, volume: 2000 } });
    const d = mod.onPositionBar(ctx);
    expect(d.kind).toBe('add_to_position');
    expect(d.mode).toBe('dca');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @trading-backtester/sdk test -- strategy-example`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/sdk/src/builder/authoring/examples/strategy-example.ts`**

```typescript
import type { ModuleBundle } from '../../../contracts/module';
import { createModuleBundle } from '../../bundle';
import { createModuleManifest } from '../../manifest';

/**
 * Worked strategy: a long breakout entry with take/stop/DCA management. Self-contained ESM, no
 * imports, deterministic (only `ctx`). Mirrors a real multi-phase strategy (flat onBarClose +
 * in-position onPositionBar). This string is the raw ESM payload shipped in the bundle.
 */
export const STRATEGY_EXAMPLE_SOURCE = `// Self-contained strategy bundle (FR-003): no imports, pre-built ESM, deterministic.
// Entry convention: default-export a factory returning the lifecycle module.
export default function createStrategyModule() {
  return {
    // Flat phase: enter long on a lookback breakout, gated by RSI.
    onBarClose(ctx) {
      if (ctx.position) return { kind: 'idle' };
      const lookback = Number(ctx.params.lookback ?? 20);
      const history = ctx.data.closedCandles(lookback);
      if (history.length < lookback) return { kind: 'idle' };
      const past = history[0];
      const changePct = ((ctx.bar.close - past.close) / past.close) * 100;
      const breakoutPct = Number(ctx.params.breakoutPct ?? 5);
      const rsi = ctx.indicators.query({ name: 'rsi', params: { period: Number(ctx.params.rsiPeriod ?? 14) } });
      const rsiMax = Number(ctx.params.rsiMax ?? 70);
      const rsiOk = typeof rsi !== 'number' || rsi <= rsiMax;
      if (changePct >= breakoutPct && rsiOk) {
        const stopPct = Number(ctx.params.stopPct ?? 5);
        const takePct = Number(ctx.params.takePct ?? 10);
        const parts = ['breakout ' + changePct.toFixed(1) + '% >= ' + breakoutPct + '%'];
        if (typeof rsi === 'number') parts.push('RSI=' + rsi.toFixed(1));
        return {
          kind: 'enter',
          side: 'long',
          stop: ctx.bar.close * (1 - stopPct / 100),
          take: ctx.bar.close * (1 + takePct / 100),
          rationale: parts.join('; '),
        };
      }
      return { kind: 'idle' };
    },
    // Management phase: take-profit / stop-loss / DCA on drawdown.
    onPositionBar(ctx) {
      const pos = ctx.position;
      if (!pos) return { kind: 'idle' };
      const pnlPct = ((ctx.bar.close - pos.entryPrice) / pos.entryPrice) * 100;
      const takePct = Number(ctx.params.takePct ?? 10);
      const stopPct = Number(ctx.params.stopPct ?? 5);
      const dcaDrawdownPct = Number(ctx.params.dcaDrawdownPct ?? 3);
      if (pnlPct >= takePct) return { kind: 'exit', target: 'all', reason: 'take ' + pnlPct.toFixed(1) + '%' };
      if (pnlPct <= -stopPct) return { kind: 'exit', target: 'all', reason: 'stop ' + pnlPct.toFixed(1) + '%' };
      if (pnlPct <= -dcaDrawdownPct) return { kind: 'add_to_position', mode: 'dca' };
      return { kind: 'idle' };
    },
  };
}
`;

export const STRATEGY_EXAMPLE_BUNDLE: ModuleBundle = createModuleBundle({
  manifest: createModuleManifest({
    id: 'example_long_breakout',
    version: '0.1.0',
    kind: 'strategy',
    name: 'Long breakout (worked example)',
    summary: 'Long entry on a lookback breakout with take/stop/DCA management.',
    rationale: 'Demonstrates a multi-phase strategy bundle: flat-phase entry + in-position management.',
    hooks: ['onBarClose', 'onPositionBar'],
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lookback: { type: 'number' },
        breakoutPct: { type: 'number' },
        rsiPeriod: { type: 'number' },
        rsiMax: { type: 'number' },
        takePct: { type: 'number' },
        stopPct: { type: 'number' },
        dcaDrawdownPct: { type: 'number' },
      },
    },
    params: { lookback: 20, breakoutPct: 5, rsiPeriod: 14, rsiMax: 70, takePct: 10, stopPct: 5, dcaDrawdownPct: 3 },
  }),
  entry: 'module/index.js',
  files: { 'module/index.js': STRATEGY_EXAMPLE_SOURCE },
});
```

- [ ] **Step 4: Append the strategy-example export to `packages/sdk/src/builder/index.ts`**

```typescript
export { STRATEGY_EXAMPLE_BUNDLE, STRATEGY_EXAMPLE_SOURCE } from './authoring/examples/strategy-example';
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @trading-backtester/sdk test -- strategy-example`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/builder/authoring/examples/strategy-example.ts packages/sdk/src/builder/index.ts packages/sdk/test/strategy-example.test.ts
git commit -m "feat(sdk): worked createStrategyModule strategy example (entry+management)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Worked overlay example + test

**Files:**
- Create: `packages/sdk/src/builder/authoring/examples/overlay-example.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/overlay-example.test.ts`

**Interfaces:**
- Produces: `OVERLAY_EXAMPLE_SOURCE: string`; `OVERLAY_EXAMPLE_BUNDLE: ModuleBundle`.

- [ ] **Step 1: Write the failing test `packages/sdk/test/overlay-example.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { OVERLAY_EXAMPLE_BUNDLE, OVERLAY_EXAMPLE_SOURCE, preflightValidateBundle } from '../src/builder/index';

async function loadFactory(source: string): Promise<(p?: unknown) => any> {
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
  const mod = await import(/* @vite-ignore */ url);
  return mod.default;
}

describe('overlay worked example', () => {
  it('passes preflight for the overlay engine', () => {
    const report = preflightValidateBundle(OVERLAY_EXAMPLE_BUNDLE, { engine: 'overlay' });
    expect(report.status).toBe('accepted');
  });

  it('apply returns a deterministic OverlayDecision', async () => {
    const factory = await loadFactory(OVERLAY_EXAMPLE_SOURCE);
    const mod = factory();
    const veto = mod.apply({ bar: { close: 100 }, params: { maxClose: 50 } });
    expect(veto.kind).toBe('veto');
    const pass = mod.apply({ bar: { close: 10 }, params: { maxClose: 50 } });
    expect(pass.kind).toBe('pass');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @trading-backtester/sdk test -- overlay-example`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/sdk/src/builder/authoring/examples/overlay-example.ts`**

```typescript
import type { ModuleBundle } from '../../../contracts/module';
import { createModuleBundle } from '../../bundle';
import { createModuleManifest } from '../../manifest';

/**
 * Worked overlay (hypothesis): vetoes the base decision when price is above a ceiling, else passes.
 * Self-contained ESM, no imports, deterministic. Same entry convention as a strategy
 * (default-export a factory), but the module exposes `apply`.
 */
export const OVERLAY_EXAMPLE_SOURCE = `// Self-contained overlay bundle (FR-003): no imports, pre-built ESM, deterministic.
export default function createStrategyModule() {
  return {
    apply(ctx) {
      const maxClose = Number(ctx.params.maxClose ?? Infinity);
      if (ctx.bar.close > maxClose) {
        return { kind: 'veto', reasonCode: 'price_above_ceiling', rationale: 'close ' + ctx.bar.close + ' > ' + maxClose };
      }
      return { kind: 'pass' };
    },
  };
}
`;

export const OVERLAY_EXAMPLE_BUNDLE: ModuleBundle = createModuleBundle({
  manifest: createModuleManifest({
    id: 'example_ceiling_veto',
    version: '0.1.0',
    kind: 'overlay',
    name: 'Ceiling veto (worked example)',
    summary: 'Vetoes entries when price is above a configured ceiling.',
    rationale: 'Demonstrates an overlay bundle: single-point apply returning an OverlayDecision.',
    hooks: ['apply'],
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { maxClose: { type: 'number' } },
    },
    params: { maxClose: 100000 },
  }),
  entry: 'module/index.js',
  files: { 'module/index.js': OVERLAY_EXAMPLE_SOURCE },
});
```

- [ ] **Step 4: Append the overlay-example export to `packages/sdk/src/builder/index.ts`**

```typescript
export { OVERLAY_EXAMPLE_BUNDLE, OVERLAY_EXAMPLE_SOURCE } from './authoring/examples/overlay-example';
```

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @trading-backtester/sdk test -- overlay-example`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/builder/authoring/examples/overlay-example.ts packages/sdk/src/builder/index.ts packages/sdk/test/overlay-example.test.ts
git commit -m "feat(sdk): worked overlay example + migrate overlay authoring into the SDK

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `scaffoldStrategyBundle` helper + test

**Files:**
- Create: `packages/sdk/src/builder/authoring/scaffold.ts`
- Modify: `packages/sdk/src/builder/index.ts`
- Create: `packages/sdk/test/scaffold.test.ts`

**Interfaces:**
- Consumes: `createModuleManifest` + `CreateModuleManifestInput` (manifest), `createModuleBundle` (bundle), `preflightValidateBundle` (preflight), `ModuleBundle` (contracts), `ValidationReport` (contracts/validation).
- Produces: `scaffoldStrategyBundle(input: ScaffoldStrategyBundleInput): ScaffoldStrategyBundleResult`.

- [ ] **Step 1: Write the failing test `packages/sdk/test/scaffold.test.ts`**

```typescript
import { describe, expect, it } from 'vitest';
import { scaffoldStrategyBundle, STRATEGY_EXAMPLE_SOURCE } from '../src/builder/index';

const input = {
  manifest: {
    id: 'scaffolded', version: '0.1.0', kind: 'strategy' as const,
    name: 'n', summary: 's', rationale: 'r',
    hooks: ['onBarClose', 'onPositionBar'] as const,
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
    paramsSchema: { type: 'object' },
  },
  entry: 'module/index.js',
  files: { 'module/index.js': STRATEGY_EXAMPLE_SOURCE },
};

describe('scaffoldStrategyBundle', () => {
  it('builds a bundle and an accepted preflight report', () => {
    const { bundle, report } = scaffoldStrategyBundle(input);
    expect(bundle.manifest.id).toBe('scaffolded');
    expect(bundle.entry).toBe('module/index.js');
    expect(report.status).toBe('accepted');
  });

  it('reports rejection for an entry not in files without throwing', () => {
    const { report } = scaffoldStrategyBundle({ ...input, entry: 'missing.js' });
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @trading-backtester/sdk test -- scaffold`
Expected: FAIL — `scaffoldStrategyBundle` not exported.

- [ ] **Step 3: Create `packages/sdk/src/builder/authoring/scaffold.ts`**

```typescript
import type { ModuleBundle } from '../../contracts/module';
import type { ValidationReport } from '../../contracts/validation';
import { createModuleBundle } from '../bundle';
import { createModuleManifest, type CreateModuleManifestInput } from '../manifest';
import { preflightValidateBundle } from '../preflight';

export interface ScaffoldStrategyBundleInput {
  readonly manifest: CreateModuleManifestInput;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ScaffoldStrategyBundleResult {
  readonly bundle: ModuleBundle;
  readonly report: ValidationReport;
}

/**
 * One-call authoring path: build the rich manifest, build the bundle, and run structural preflight
 * for the strategy engine ('momentum'). Does NOT throw on validation errors — inspect
 * `report.status`. For overlays, build with `createModuleBundle` + `preflightValidateBundle({ engine:
 * 'overlay' })` directly.
 */
export function scaffoldStrategyBundle(input: ScaffoldStrategyBundleInput): ScaffoldStrategyBundleResult {
  const bundle = createModuleBundle({
    manifest: createModuleManifest(input.manifest),
    entry: input.entry,
    files: input.files,
  });
  const report = preflightValidateBundle(bundle, { engine: 'momentum' });
  return { bundle, report };
}
```

- [ ] **Step 4: Append the scaffold export to `packages/sdk/src/builder/index.ts`**

```typescript
export {
  scaffoldStrategyBundle,
  type ScaffoldStrategyBundleInput,
  type ScaffoldStrategyBundleResult,
} from './authoring/scaffold';
```

- [ ] **Step 5: Run — expect PASS, then full SDK suite + build**

Run: `pnpm --filter @trading-backtester/sdk test && pnpm --filter @trading-backtester/sdk build`
Expected: all tests PASS; build succeeds (tsup bundles `authoring/*` into `dist/builder/index.js`; api-extractor rolls up the new types into `dist/builder/index.d.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/builder/authoring/scaffold.ts packages/sdk/src/builder/index.ts packages/sdk/test/scaffold.test.ts
git commit -m "feat(sdk): scaffoldStrategyBundle one-call authoring helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: App-side CI-gated sandbox execution test + lab-next-steps note

**Files:**
- Create: `apps/backtester/test/sdk-strategy-example.test.ts`
- Modify: `packages/sdk/README.md`

**Interfaces:**
- Consumes: `STRATEGY_EXAMPLE_BUNDLE` (`@trading-backtester/sdk/builder`); `buildTestApp`, `AUTH`, `runBody`, `testDeps`, `HARNESS_DIR` (`apps/backtester/test/helpers`); `InMemoryBundleStore`; `DOCKER_AVAILABLE` (`apps/backtester/test/store-factories`).

- [ ] **Step 1: Write the CI-gated sandbox execution test `apps/backtester/test/sdk-strategy-example.test.ts`**

This proves the SDK's worked example is entry-convention compatible end-to-end through the real
sandbox executor. It is `describe.skipIf(!DOCKER_AVAILABLE)` — skipped (not failed) locally in WSL2;
CI is the gate. Model it on `apps/backtester/test/sandbox.test.ts`.

```typescript
// Docker-gated: proves the SDK worked strategy example runs in the real sandbox. Skips when no
// Docker daemon is reachable (CI is the sandbox-path gate).
import { describe, expect, it } from 'vitest';
import type { RunResultSummary, RunStatusView } from '@trading/research-contracts';
import { STRATEGY_EXAMPLE_BUNDLE } from '@trading-backtester/sdk/builder';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store';
import { AUTH, buildTestApp, HARNESS_DIR, runBody, testDeps } from './helpers';
import { DOCKER_AVAILABLE } from './store-factories';

function sandboxSettings(wallTimeMs: number) {
  return { harnessDir: HARNESS_DIR, image: 'node:24-alpine', memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeMs, tmpfsMb: 64, user: '65534:65534' };
}

describe.skipIf(!DOCKER_AVAILABLE)('SDK worked strategy example (sandbox)', () => {
  it(
    'runs the SDK STRATEGY_EXAMPLE_BUNDLE in the sandbox and completes',
    async () => {
      const app = await buildTestApp({ sandbox: sandboxSettings(20_000) }, testDeps({ bundleStore: new InMemoryBundleStore() }));
      try {
        const submit = await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'sdk-ex-1', moduleBundle: STRATEGY_EXAMPLE_BUNDLE }),
        });
        expect(submit.statusCode).toBe(202);
        expect(await app.drain()).toBe(1);
        const status = (await app.server.inject({ url: '/v1/runs/sdk-ex-1/status', headers: AUTH })).json() as RunStatusView;
        expect(status.status).toBe('completed');
        const result = (await app.server.inject({ url: '/v1/runs/sdk-ex-1/result', headers: AUTH })).json() as RunResultSummary;
        expect(result.evidence.bundleHash).toMatch(/^sha256:/);
      } finally {
        await app.dispose();
      }
    },
    60_000,
  );
});
```

> Implementation note: confirm `runBody`'s `moduleBundle` field accepts a `@trading-backtester/sdk`
> `ModuleBundle` (the strategy engine path consumes `manifest.hooks` via `createInertStrategyModule`).
> If `runBody` types `moduleBundle` against the `@trading/research-contracts` `ModuleBundle`, cast at
> the call site (`moduleBundle: STRATEGY_EXAMPLE_BUNDLE as never`) and leave a one-line comment —
> unifying the two bundle types is the documented follow-up, not this task.

- [ ] **Step 2: Run the test locally (expect SKIP in WSL2)**

Run: `pnpm --filter backtester test -- sdk-strategy-example`
Expected: the suite is SKIPPED (no Docker) — 0 failures. (In CI with Docker it runs and passes.)

- [ ] **Step 3: Add the "what lab does next" note to `packages/sdk/README.md`**

Append a short section to `packages/sdk/README.md`:

```markdown
## Strategy authoring (for the lab builder)

The `@trading-backtester/sdk/builder` subpath now carries the strategy-authoring surface:

- `getAuthoringDoc('strategy' | 'overlay')` + `STRATEGY_AUTHORING_DOC` / `OVERLAY_AUTHORING_DOC` —
  the prose fed to the LLM builder.
- `STRATEGY_EXAMPLE_BUNDLE` / `STRATEGY_EXAMPLE_SOURCE` (and the overlay equivalents) — worked,
  self-contained `export default createStrategyModule` bundles.
- `scaffoldStrategyBundle({ manifest, entry, files })` — build + preflight in one call.
- `computeBundleHash(rawBytes)` — the cross-boundary `sha256:<hex>` pin over raw ESM bytes
  (distinct from the internal structural `computeInlineBundleHash`).

**Canonical contract:** the SDK contract is authoritative — `{ id, version, kind,
bundleContractVersion }` plus the rich kernel manifest fields; `bundleHash` is the sha256 of the raw
ESM bytes.

**Next on the lab side (separate task):** depend on `@trading-backtester/sdk`; consume
`getAuthoringDoc` + the example in the builder prompt/RAG; converge lab's `module-bundle-v1` to this
canonical contract; update the lab schema/validator/prompt to emit strategy bundles; then build the
proof-harness (generate → backtester validate+sign → platform paper-isolated vs curated `long_oi` →
compare).
```

- [ ] **Step 4: Final workspace sweep**

Run: `pnpm -r typecheck && pnpm --filter @trading-backtester/sdk test && pnpm --filter backtester test`
Expected: all green (the new app sandbox test SKIPs in WSL2).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/sdk-strategy-example.test.ts packages/sdk/README.md
git commit -m "test(sdk): CI-gated sandbox execution of the worked example + lab-next-steps note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Authoring doc + worked strategy example (entry+management) → Tasks 3, 4. ✓
- Overlay doc migrated into SDK + worked overlay example → Tasks 3, 5. ✓
- `getAuthoringDoc(kind)` + raw constants → Task 3 (+ example constants Tasks 4/5). ✓
- `computeBundleHash(rawBytes)` distinct from `computeInlineBundleHash` → Task 2. ✓
- `scaffoldStrategyBundle` + dedicated test → Task 6. ✓
- Example passes preflight (`kind='strategy'`) + executes deterministically (direct ESM Task 4; sandbox CI-gated Task 7). ✓
- Canonical contract fixed (forms + `bundleHash`=raw-bytes) → Task 1 (BundleManifest) + README note Task 7. ✓
- All breaking consumers migrated; `tsc` clean; version bump 0.3.0 → Task 1. ✓
- Short lab-next-steps note → Task 7. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Two `Implementation note` callouts (kernel field confirmation already resolved in Task 1 from the kernel `.d.ts`; `runBody` type cast) are explicit, actionable instructions, not placeholders.

**3. Type consistency:** `createModuleManifest` returns `BundleManifest` (Tasks 1, 4, 5, 6). `computeBundleHash`/`computeInlineBundleHash` signatures match between Task 2 definition and Tasks 4/strategy-example usage. `ScaffoldStrategyBundleInput.manifest: CreateModuleManifestInput` matches the Task 1 input shape. `getAuthoringDoc(kind: ModuleKind)` matches the re-sourced `ModuleKind`. Example hook arrays (`['onBarClose','onPositionBar']`, `['apply']`) match `LifecycleHook`.

## Execution Handoff

Plan complete. See below for execution options.
