# @trading-backtester/sdk

Standalone authoring, contracts, artifacts, and HTTP client SDK for the trading-backtester platform.

- **License:** Apache-2.0
- **Node:** >=22 (ESM only)
- **No live-order execution** — the SDK carries no exchange credentials or brokerage connectivity; it is a pure authoring and API-integration library.

---

## Installation

Install from the GitHub Release tarball (no registry required):

```sh
npm install https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.1.0/trading-backtester-sdk-0.1.0.tgz
```

Or with pnpm:

```sh
pnpm add https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.1.0/trading-backtester-sdk-0.1.0.tgz
```

---

## Import paths

The SDK ships five subpath exports. All are ESM-only; use `"type": "module"` and a NodeNext/Bundler `moduleResolution` in TypeScript.

| Subpath | Contents |
|---|---|
| `@trading-backtester/sdk` | Root — `SDK_VERSION`, capability flags |
| `@trading-backtester/sdk/contracts` | Core type contracts, schema assets, `allSchemaAssets()` |
| `@trading-backtester/sdk/builder` | `createModuleManifest`, `createModuleBundle`, `computeInlineBundleHash`, `preflightValidateBundle` |
| `@trading-backtester/sdk/client` | `BacktesterClient` HTTP client, error types |
| `@trading-backtester/sdk/artifacts` | `isContentHash` and artifact guard utilities |

---

## Examples

### Momentum signals overlay module

Compute signals from a candle series and package them as a runnable overlay module:

```ts
import { createModuleManifest, createModuleBundle, computeInlineBundleHash } from '@trading-backtester/sdk/builder';
import { isContentHash } from '@trading-backtester/sdk/artifacts';

function signals(candles: { close: number }[], seed: number) {
  // simple momentum: price relative to n-period average
  const period = Math.max(1, seed);
  return candles.map((c, i) => {
    const window = candles.slice(Math.max(0, i - period + 1), i + 1);
    const avg = window.reduce((s, w) => s + w.close, 0) / window.length;
    return { momentum: (c.close - avg) / avg };
  });
}

const manifest = createModuleManifest({
  id: 'my-momentum-overlay',
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

const entrySource = `
export default function apply({ candles, seed }) {
  const period = Math.max(1, seed ?? 20);
  return candles.map((c, i) => {
    const w = candles.slice(Math.max(0, i - period + 1), i + 1);
    const avg = w.reduce((s, x) => s + x.close, 0) / w.length;
    return { momentum: (c.close - avg) / avg };
  });
}
`;

const bundle = createModuleBundle({
  manifest,
  entry: 'index.js',
  files: { 'index.js': entrySource },
});

const hash = computeInlineBundleHash(bundle);
console.assert(isContentHash(hash), 'hash must be a valid ContentHash');
```

### Authoring types and lifecycle

```ts
import type { ModuleManifest, ModuleBundle } from '@trading-backtester/sdk/contracts';
import { preflightValidateBundle } from '@trading-backtester/sdk/builder';

// Local preflight — catches structural errors before submitting to the service.
// This is not authoritative validation; the service performs authoritative validation
// against the full platform contract.
async function prepareBundle(bundle: ModuleBundle): Promise<void> {
  const result = await preflightValidateBundle(bundle);
  if (!result.ok) {
    throw new Error(`Preflight failed: ${result.errors.map(e => e.message).join(', ')}`);
  }
  console.log('Bundle passed local preflight. Submit for authoritative validation via BacktesterClient.');
}
```

### HTTP client — submit, poll, and read artifacts

```ts
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';

const client = new BacktesterClient({ baseUrl: 'https://your-backtester-host' });

// Submit a run
const { runId } = await client.submitRun({
  moduleId: 'my-momentum-overlay',
  bundleHash: 'sha256:abc123...',
  datasetId: 'sp500-daily-2023',
  parameters: { seed: 20 },
});

// Await completion
const result = await client.awaitCompletion(runId);
console.log('Metrics:', result.metrics);

// Read artifacts — bounded/paginated
const manifest = await client.getArtifactManifest(runId);
for (const entry of manifest.entries.slice(0, 10)) {
  if (isContentHash(entry.contentHash)) {
    const artifact = await client.readArtifact(runId, entry.path, { maxBytes: 1_000_000 });
    console.log(entry.path, artifact.byteLength, 'bytes');
  }
}
```

---

## Local preflight vs. authoritative validation

`preflightValidateBundle` runs locally with no network access. It validates structural
constraints (manifest shape, required fields, file-set consistency) — useful for fast
feedback during authoring.

**Authoritative validation** is performed by the backtester service when you call
`client.validateModule(...)` or `client.submitRun(...)`. The service validates against
the full platform contract schema (schema/017) and enforces additional runtime constraints
not checked locally. Always treat authoritative validation as the ground truth.

---

## Bounded artifact reads

`client.readArtifact(runId, path, { maxBytes })` enforces a byte cap. Pass `maxBytes`
to bound memory usage. For large artifacts, use the paginated
`client.readArtifact(runId, path, { offset, maxBytes })` to stream in chunks.

---

## Requirements

- **Node >= 22** (uses native `crypto.subtle` for SHA-256)
- **ESM only** — all entry points are `"type": "module"`; set `"moduleResolution": "NodeNext"` or `"Bundler"` in `tsconfig.json`
- `decimal.js` is the only runtime dependency (bundled in the tarball; no registry resolution needed at install time)
