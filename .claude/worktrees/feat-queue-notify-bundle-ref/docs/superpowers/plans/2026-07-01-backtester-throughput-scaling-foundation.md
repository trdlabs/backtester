# Phase C Foundation — horizontal workers + S3-compatible shared store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `trading-backtester` horizontally scalable — a cluster-visible S3-compatible object store behind the existing store interfaces, a first-class API/worker deployment split with worker health probes, and copyable Kubernetes/KEDA reference manifests — without weakening any sandbox or determinism invariant.

**Architecture:** Add S3-compatible adapters behind the unchanged `ArtifactStore` / `BundleStore` interfaces, selected by an env-driven factory (default `filesystem`, so dev/CI is byte-identical). The adapters depend only on a tiny `S3ObjectClient` port, so tests inject an in-memory fake and the real `@aws-sdk/client-s3` is a runtime-only dynamic import (MinIO is the first-class target; AWS S3 is one interchangeable backend). Add an optional worker health server and reference deploy artifacts.

**Tech Stack:** TypeScript (ESM, strict), Node ≥22, pnpm 11.6.0, vitest 2.1.8, Fastify (existing API), Postgres (`pg`), `@aws-sdk/client-s3` (optional, dynamic).

**Design spec:** [`docs/superpowers/specs/2026-07-01-backtester-throughput-scaling-foundation-design.md`](../specs/2026-07-01-backtester-throughput-scaling-foundation-design.md)

## Global Constraints

- **Default store backend is `filesystem`** — dev/CI/local behavior stays byte-identical to today. S3 is opt-in via `BACKTESTER_STORE_BACKEND=s3`.
- **Never change `result_hash`** — S3 adapters MUST reuse `contentRef` / `bundleHash` + `canonicalJson` unchanged. Content hashes are identical to the filesystem path; no golden fixtures move.
- **Never weaken the sandbox** — no changes to `engine/sandbox/*` isolation flags or the sandbox executor in this plan.
- **Out of scope (do NOT add here):** per-tenant quotas/fairness, fingerprint-based dedup, `ScaledJob`/worker-once mode, gVisor/Kata/Firecracker, Temporal. If any creeps in, stop and split it out.
- **`@aws-sdk/client-s3` is a runtime-only dependency** — imported through a widened specifier (`const S3_SPECIFIER: string = '@aws-sdk/client-s3'`) so it is not a compile-time dependency. Adapters depend only on the `S3ObjectClient` port, never on AWS SDK types.
- **`BACKTESTER_S3_*` names denote the S3 protocol/API, not the AWS vendor.** MinIO first-class: `forcePathStyle` defaults to `true` unless explicitly `"false"`.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Test command:** run a single file with `pnpm vitest run apps/backtester/test/<file>.test.ts`; a single case with `-t "<name>"`. Typecheck with `pnpm typecheck`.
- **Import style:** new files under `src/artifacts/`, `src/sandbox/`, `src/storage/` use extensionless relative imports (matching `artifacts/store.ts`, `sandbox/bundle-store.ts`). Tests import `../src/...` extensionless.

## File Structure

- Create `apps/backtester/src/storage/s3-client.ts` — `S3ObjectClient` port, `S3Settings`, `createS3ObjectClient` (runtime dynamic import + fail-fast).
- Create `apps/backtester/src/storage/stores.ts` — `createArtifactStore` / `createBundleStore` factories.
- Create `apps/backtester/src/artifacts/s3-store.ts` — `S3ArtifactStore`.
- Create `apps/backtester/src/sandbox/s3-bundle-store.ts` — `S3BundleStore`.
- Create `apps/backtester/src/jobs/worker-health.ts` — `startWorkerHealthServer`.
- Create `apps/backtester/test/support/fake-s3.ts` — in-memory `S3ObjectClient` test double.
- Modify `apps/backtester/src/config.ts` — `storeBackend` + `s3` on `AppConfig`, env parse + fail-fast.
- Modify `apps/backtester/src/app.ts` — `buildApp` uses the factories.
- Modify `apps/backtester/src/worker-main.ts` — optional `WORKER_HEALTH_PORT` health server + SIGTERM readiness flip.
- Modify `apps/backtester/package.json` — add `@aws-sdk/client-s3` to `optionalDependencies`.
- Create `deploy/k8s/examples/{api-deployment,worker-deployment,keda-scaledobject,minio}.yaml`.
- Modify `docs/OPERATIONS.md`, `docs/ROADMAP.md`.
- Tests: `test/s3-store.test.ts`, `test/store-factory.test.ts`, `test/config-store.test.ts`, `test/worker-health.test.ts`.

---

### Task 1: S3ObjectClient port + real client + in-memory fake

**Files:**
- Create: `apps/backtester/src/storage/s3-client.ts`
- Create: `apps/backtester/test/support/fake-s3.ts`
- Test: `apps/backtester/test/s3-store.test.ts` (the fake-contract case; extended in Tasks 2–3)

**Interfaces:**
- Produces:
  - `interface S3ObjectClient { put(key: string, body: string): Promise<void>; get(key: string): Promise<string | undefined>; head(key: string): Promise<boolean>; }`
  - `interface S3Settings { readonly endpoint: string; readonly bucket: string; readonly region?: string; readonly accessKeyId: string; readonly secretAccessKey: string; readonly forcePathStyle: boolean; }`
  - `function createS3ObjectClient(cfg: S3Settings): Promise<S3ObjectClient>`
  - test double `function createFakeS3Client(store?: Map<string, string>): S3ObjectClient`

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/s3-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createFakeS3Client } from './support/fake-s3';

describe('S3ObjectClient fake contract', () => {
  it('put→get round-trips, head reflects presence, absent get is undefined', async () => {
    const client = createFakeS3Client();
    expect(await client.head('k')).toBe(false);
    expect(await client.get('k')).toBeUndefined();
    await client.put('k', 'value');
    expect(await client.head('k')).toBe(true);
    expect(await client.get('k')).toBe('value');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts`
Expected: FAIL — cannot find module `./support/fake-s3`.

- [ ] **Step 3: Write the port + real client**

`apps/backtester/src/storage/s3-client.ts`:
```ts
// S3-compatible object-store port. The adapters depend ONLY on this interface, never on AWS SDK
// types. @aws-sdk/client-s3 is imported at runtime through a WIDENED specifier so it is not a
// compile-time dependency and the same client speaks to any S3-compatible endpoint (MinIO, AWS, …).

export interface S3ObjectClient {
  /** Idempotent — key is a content hash, so identical bytes overwrite the identical object. */
  put(key: string, body: string): Promise<void>;
  /** Resolves to undefined when the object is absent. */
  get(key: string): Promise<string | undefined>;
  head(key: string): Promise<boolean>;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

// Widened to `string` so TypeScript does not resolve the module type at compile time.
const S3_SPECIFIER: string = '@aws-sdk/client-s3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNotFound(err: any): boolean {
  return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

export async function createS3ObjectClient(cfg: S3Settings): Promise<S3ObjectClient> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aws: any;
  try {
    aws = await import(S3_SPECIFIER);
  } catch {
    throw new Error(
      "store backend 's3' requires @aws-sdk/client-s3 to be installed (pnpm add @aws-sdk/client-s3)",
    );
  }
  const s3 = new aws.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? 'us-east-1',
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async put(key, body) {
      await s3.send(new aws.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body }));
    },
    async get(key) {
      try {
        const r = await s3.send(new aws.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return (await r.Body.transformToString()) as string;
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },
    async head(key) {
      try {
        await s3.send(new aws.HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}
```

`apps/backtester/test/support/fake-s3.ts`:
```ts
import type { S3ObjectClient } from '../../src/storage/s3-client';

/** In-memory S3ObjectClient double — the adapters' contract, no AWS/MinIO required. */
export function createFakeS3Client(store: Map<string, string> = new Map()): S3ObjectClient {
  return {
    async put(key, body) {
      store.set(key, body);
    },
    async get(key) {
      return store.get(key);
    },
    async head(key) {
      return store.has(key);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no `@aws-sdk/client-s3` needed at compile time).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/storage/s3-client.ts apps/backtester/test/support/fake-s3.ts apps/backtester/test/s3-store.test.ts
git commit -m "feat(storage): S3ObjectClient port + runtime client + in-memory fake"
```

---

### Task 2: S3ArtifactStore

**Files:**
- Create: `apps/backtester/src/artifacts/s3-store.ts`
- Test: `apps/backtester/test/s3-store.test.ts` (append)

**Interfaces:**
- Consumes: `S3ObjectClient` (Task 1); `ArtifactStore` interface + `InMemoryArtifactStore` from `../artifacts/store`; `contentRef` from `../determinism/hash`; `canonicalJson` from `../determinism/canonical-json`.
- Produces: `class S3ArtifactStore implements ArtifactStore { constructor(client: S3ObjectClient) }` with `write(payload): Promise<ContentHash>`, `read(ref): Promise<unknown>`, `has(ref): Promise<boolean>`. Object key: `artifacts/<hex>.json`.

- [ ] **Step 1: Write the failing test (append to `test/s3-store.test.ts`)**

```ts
import { S3ArtifactStore } from '../src/artifacts/s3-store';
import { InMemoryArtifactStore } from '../src/artifacts/store';

describe('S3ArtifactStore', () => {
  it('write→read round-trips and has() tracks presence', async () => {
    const store = new S3ArtifactStore(createFakeS3Client());
    const payload = { runId: 'r1', metrics: { pnl: 1 } };
    const ref = await store.write(payload);
    expect(ref).toMatch(/^sha256:/);
    expect(await store.has(ref)).toBe(true);
    expect(await store.read(ref)).toEqual(payload);
  });

  it('read of an absent ref throws', async () => {
    const store = new S3ArtifactStore(createFakeS3Client());
    await expect(store.read('sha256:deadbeef')).rejects.toThrow(/not found/);
  });

  it('stores under the artifacts/<hex>.json key', async () => {
    const backing = new Map<string, string>();
    const store = new S3ArtifactStore(createFakeS3Client(backing));
    const ref = await store.write({ a: 1 });
    const hex = ref.slice('sha256:'.length);
    expect([...backing.keys()]).toEqual([`artifacts/${hex}.json`]);
  });

  it('DETERMINISM: identical ContentHash to InMemoryArtifactStore for the same payload', async () => {
    const payload = { x: 1, y: [2, 3], z: 'k' };
    const s3Ref = await new S3ArtifactStore(createFakeS3Client()).write(payload);
    const memRef = await new InMemoryArtifactStore().write(payload);
    expect(s3Ref).toBe(memRef);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts -t "S3ArtifactStore"`
Expected: FAIL — cannot find module `../src/artifacts/s3-store`.

- [ ] **Step 3: Write the implementation**

`apps/backtester/src/artifacts/s3-store.ts`:
```ts
// S3-compatible ArtifactStore — same content-addressing (contentRef + canonicalJson) as the
// filesystem store, so ContentHash values are byte-identical. Key layout: artifacts/<hex>.json.

import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import { canonicalJson } from '../determinism/canonical-json';
import { contentRef } from '../determinism/hash';
import type { ArtifactStore } from './store';
import type { S3ObjectClient } from '../storage/s3-client';

const hexOf = (ref: ContentHash): string => ref.slice('sha256:'.length);
const keyFor = (ref: ContentHash): string => `artifacts/${hexOf(ref)}.json`;

export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly client: S3ObjectClient) {}

  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    await this.client.put(keyFor(ref), canonicalJson(payload));
    return ref;
  }

  async read(ref: ContentHash): Promise<unknown> {
    const raw = await this.client.get(keyFor(ref));
    if (raw === undefined) throw new Error(`artifact not found: ${ref}`);
    return JSON.parse(raw);
  }

  async has(ref: ContentHash): Promise<boolean> {
    return this.client.head(keyFor(ref));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts`
Expected: PASS (all S3ArtifactStore cases + Task 1 case).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/artifacts/s3-store.ts apps/backtester/test/s3-store.test.ts
git commit -m "feat(storage): S3ArtifactStore behind ArtifactStore interface (hash-identical)"
```

---

### Task 3: S3BundleStore

**Files:**
- Create: `apps/backtester/src/sandbox/s3-bundle-store.ts`
- Test: `apps/backtester/test/s3-store.test.ts` (append)

**Interfaces:**
- Consumes: `S3ObjectClient` (Task 1); `BundleStore` interface + `InMemoryBundleStore` from `../sandbox/bundle-store`; `bundleHash` from `../sandbox/bundle`; `ContentHash`/`ModuleBundle` from `@trading/research-contracts`; `canonicalJson`.
- Produces: `class S3BundleStore implements BundleStore { constructor(client: S3ObjectClient) }` with `put(bundle): Promise<ContentHash>`, `get(hash): Promise<ModuleBundle | undefined>`, `has(hash): Promise<boolean>`. Object key: `bundles/<hex>.json`.

- [ ] **Step 1: Write the failing test (append to `test/s3-store.test.ts`)**

```ts
import { S3BundleStore } from '../src/sandbox/s3-bundle-store';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store';
import { bundleHash } from '../src/sandbox/bundle';
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';

function makeBundle(): ModuleBundle {
  const manifest = createModuleManifest({
    id: 'b',
    version: '1.0.0',
    kind: 'strategy',
    name: 'fixture',
    summary: 's',
    rationale: 'r',
    hooks: ['onBarClose'],
    paramsSchema: { type: 'object' },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
  });
  return { manifest, entry: 'module.mjs', files: { 'module.mjs': 'export function signals(c){return c.map(()=>false);}' } };
}

describe('S3BundleStore', () => {
  it('put→get round-trips and returns the same hash as bundleHash', async () => {
    const store = new S3BundleStore(createFakeS3Client());
    const b = makeBundle();
    const hash = await store.put(b);
    expect(hash).toBe(bundleHash(b));
    expect(await store.has(hash)).toBe(true);
    expect(await store.get(hash)).toEqual(b);
  });

  it('get of an absent hash is undefined', async () => {
    const store = new S3BundleStore(createFakeS3Client());
    expect(await store.get('sha256:deadbeef')).toBeUndefined();
  });

  it('stores under the bundles/<hex>.json key', async () => {
    const backing = new Map<string, string>();
    const hash = await new S3BundleStore(createFakeS3Client(backing)).put(makeBundle());
    const hex = hash.slice('sha256:'.length);
    expect([...backing.keys()]).toEqual([`bundles/${hex}.json`]);
  });

  it('DETERMINISM: identical hash to InMemoryBundleStore for the same bundle', async () => {
    const b = makeBundle();
    const s3Hash = await new S3BundleStore(createFakeS3Client()).put(b);
    const memHash = await new InMemoryBundleStore().put(b);
    expect(s3Hash).toBe(memHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts -t "S3BundleStore"`
Expected: FAIL — cannot find module `../src/sandbox/s3-bundle-store`.

- [ ] **Step 3: Write the implementation**

`apps/backtester/src/sandbox/s3-bundle-store.ts`:
```ts
// S3-compatible BundleStore — same content-addressing (bundleHash + canonicalJson) as the
// filesystem store. Key layout: bundles/<hex>.json.

import type { ContentHash, ModuleBundle } from '@trading/research-contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { bundleHash } from './bundle';
import type { BundleStore } from './bundle-store';
import type { S3ObjectClient } from '../storage/s3-client';

const hexOf = (ref: ContentHash): string => ref.slice('sha256:'.length);
const keyFor = (hash: ContentHash): string => `bundles/${hexOf(hash)}.json`;

export class S3BundleStore implements BundleStore {
  constructor(private readonly client: S3ObjectClient) {}

  async put(bundle: ModuleBundle): Promise<ContentHash> {
    const hash = bundleHash(bundle);
    await this.client.put(keyFor(hash), canonicalJson(bundle));
    return hash;
  }

  async get(hash: ContentHash): Promise<ModuleBundle | undefined> {
    const raw = await this.client.get(keyFor(hash));
    return raw === undefined ? undefined : (JSON.parse(raw) as ModuleBundle);
  }

  async has(hash: ContentHash): Promise<boolean> {
    return this.client.head(keyFor(hash));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/backtester/test/s3-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/sandbox/s3-bundle-store.ts apps/backtester/test/s3-store.test.ts
git commit -m "feat(storage): S3BundleStore behind BundleStore interface (hash-identical)"
```

---

### Task 4: Config — storeBackend + s3 settings + fail-fast

**Files:**
- Modify: `apps/backtester/src/config.ts` (add fields to `AppConfig`; parse env in `loadConfig`)
- Test: `apps/backtester/test/config-store.test.ts`

**Interfaces:**
- Consumes: `S3Settings` from `./storage/s3-client` (Task 1).
- Produces: `AppConfig.storeBackend: 'filesystem' | 's3'` and `AppConfig.s3?: S3Settings`. `loadConfig(env)` throws when `BACKTESTER_STORE_BACKEND=s3` and any of endpoint/bucket/access-key/secret-key is missing.

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/config-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('store backend config', () => {
  it('defaults to filesystem when unset', () => {
    expect(loadConfig({}).storeBackend).toBe('filesystem');
    expect(loadConfig({}).s3).toBeUndefined();
  });

  it('parses a complete s3 config (MinIO defaults: forcePathStyle=true)', () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'http://minio:9000',
      BACKTESTER_S3_BUCKET: 'backtester',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
    });
    expect(cfg.storeBackend).toBe('s3');
    expect(cfg.s3).toEqual({
      endpoint: 'http://minio:9000',
      bucket: 'backtester',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      forcePathStyle: true,
    });
  });

  it('honors forcePathStyle=false (AWS variant) and optional region', () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      BACKTESTER_S3_BUCKET: 'b',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
      BACKTESTER_S3_REGION: 'us-east-1',
      BACKTESTER_S3_FORCE_PATH_STYLE: 'false',
    });
    expect(cfg.s3?.forcePathStyle).toBe(false);
    expect(cfg.s3?.region).toBe('us-east-1');
  });

  it('fail-fast when s3 selected but required settings are missing', () => {
    expect(() =>
      loadConfig({ BACKTESTER_STORE_BACKEND: 's3', BACKTESTER_S3_ENDPOINT: 'http://minio:9000' }),
    ).toThrow(/BACKTESTER_S3_BUCKET/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/config-store.test.ts`
Expected: FAIL — `storeBackend` is undefined.

- [ ] **Step 3: Add the import and AppConfig fields**

In `apps/backtester/src/config.ts`, add to the imports at the top:
```ts
import type { S3Settings } from './storage/s3-client';
```

Add these members to the `AppConfig` interface (next to `bundlesDir`):
```ts
  /** Object-store backend for artifacts + bundles. Default 'filesystem' (host-local, dev/CI). */
  readonly storeBackend: 'filesystem' | 's3';
  /** S3-compatible settings; present only when storeBackend === 's3'. */
  readonly s3?: S3Settings;
```

- [ ] **Step 4: Parse and validate env in `loadConfig`**

In `apps/backtester/src/config.ts`, inside `loadConfig`, just before the `return {` statement add:
```ts
  const storeBackend: 'filesystem' | 's3' = env.BACKTESTER_STORE_BACKEND === 's3' ? 's3' : 'filesystem';
  let s3: S3Settings | undefined;
  if (storeBackend === 's3') {
    const endpoint = env.BACKTESTER_S3_ENDPOINT;
    const bucket = env.BACKTESTER_S3_BUCKET;
    const accessKeyId = env.BACKTESTER_S3_ACCESS_KEY;
    const secretAccessKey = env.BACKTESTER_S3_SECRET_KEY;
    const missing = (
      [
        ['BACKTESTER_S3_ENDPOINT', endpoint],
        ['BACKTESTER_S3_BUCKET', bucket],
        ['BACKTESTER_S3_ACCESS_KEY', accessKeyId],
        ['BACKTESTER_S3_SECRET_KEY', secretAccessKey],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(`store backend 's3' requires ${missing.join(', ')}`);
    }
    s3 = {
      endpoint: endpoint!,
      bucket: bucket!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      // MinIO is the first-class target: default true unless explicitly disabled (AWS ⇒ 'false').
      forcePathStyle: env.BACKTESTER_S3_FORCE_PATH_STYLE !== 'false',
      ...(env.BACKTESTER_S3_REGION ? { region: env.BACKTESTER_S3_REGION } : {}),
    };
  }
```

Then add to the returned object literal (next to `bundlesDir: ...`):
```ts
    storeBackend,
    ...(s3 ? { s3 } : {}),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run apps/backtester/test/config-store.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-store.test.ts
git commit -m "feat(config): storeBackend + s3 settings with fail-fast validation"
```

---

### Task 5: Store factory + buildApp wiring

**Files:**
- Create: `apps/backtester/src/storage/stores.ts`
- Modify: `apps/backtester/src/app.ts` (`buildApp` uses the factories; adjust imports)
- Test: `apps/backtester/test/store-factory.test.ts`

**Interfaces:**
- Consumes: `AppConfig` (Task 4); `FileArtifactStore` from `../artifacts/store`; `FileBundleStore` from `../sandbox/bundle-store`; `S3ArtifactStore` (Task 2); `S3BundleStore` (Task 3); `createS3ObjectClient` + `S3ObjectClient` (Task 1).
- Produces:
  - `function createArtifactStore(config: AppConfig, injected?: S3ObjectClient): Promise<ArtifactStore>`
  - `function createBundleStore(config: AppConfig, injected?: S3ObjectClient): Promise<BundleStore>`

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/store-factory.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createArtifactStore, createBundleStore } from '../src/storage/stores';
import { FileArtifactStore } from '../src/artifacts/store';
import { FileBundleStore } from '../src/sandbox/bundle-store';
import { S3ArtifactStore } from '../src/artifacts/s3-store';
import { S3BundleStore } from '../src/sandbox/s3-bundle-store';
import { createFakeS3Client } from './support/fake-s3';

describe('store factory', () => {
  it('returns filesystem stores by default', async () => {
    const cfg = loadConfig({});
    expect(await createArtifactStore(cfg)).toBeInstanceOf(FileArtifactStore);
    expect(await createBundleStore(cfg)).toBeInstanceOf(FileBundleStore);
  });

  it('returns S3 stores when backend=s3, using the injected client', async () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'http://minio:9000',
      BACKTESTER_S3_BUCKET: 'b',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
    });
    const client = createFakeS3Client();
    expect(await createArtifactStore(cfg, client)).toBeInstanceOf(S3ArtifactStore);
    expect(await createBundleStore(cfg, client)).toBeInstanceOf(S3BundleStore);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/store-factory.test.ts`
Expected: FAIL — cannot find module `../src/storage/stores`.

- [ ] **Step 3: Write the factory**

`apps/backtester/src/storage/stores.ts`:
```ts
// Env-driven store factory. Default 'filesystem' → host-local File*Store (dev/CI byte-identical).
// 's3' → S3-compatible adapter. `injected` is the test seam (production passes nothing and the
// factory builds a real client via createS3ObjectClient).

import type { AppConfig } from '../config';
import { FileArtifactStore, type ArtifactStore } from '../artifacts/store';
import { FileBundleStore, type BundleStore } from '../sandbox/bundle-store';
import { S3ArtifactStore } from '../artifacts/s3-store';
import { S3BundleStore } from '../sandbox/s3-bundle-store';
import { createS3ObjectClient, type S3ObjectClient } from './s3-client';

async function s3ClientFor(config: AppConfig, injected?: S3ObjectClient): Promise<S3ObjectClient> {
  if (injected) return injected;
  if (!config.s3) throw new Error("store backend 's3' selected but s3 settings are missing");
  return createS3ObjectClient(config.s3);
}

export async function createArtifactStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<ArtifactStore> {
  if (config.storeBackend === 's3') return new S3ArtifactStore(await s3ClientFor(config, injected));
  return new FileArtifactStore(config.artifactsDir);
}

export async function createBundleStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<BundleStore> {
  if (config.storeBackend === 's3') return new S3BundleStore(await s3ClientFor(config, injected));
  return new FileBundleStore(config.bundlesDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/store-factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `buildApp` to the factories**

In `apps/backtester/src/app.ts`, replace these two lines:
```ts
  const artifactStore = overrides.artifactStore ?? new FileArtifactStore(config.artifactsDir);
  const bundleStore = overrides.bundleStore ?? new FileBundleStore(config.bundlesDir);
```
with:
```ts
  const artifactStore = overrides.artifactStore ?? (await createArtifactStore(config));
  const bundleStore = overrides.bundleStore ?? (await createBundleStore(config));
```

Then fix imports in `apps/backtester/src/app.ts`:
- Add: `import { createArtifactStore, createBundleStore } from './storage/stores';`
- Change `import { FileArtifactStore } from './artifacts/store';` to `import type { ArtifactStore } from './artifacts/store';` **only if** `FileArtifactStore` is now otherwise unused in the file (grep it first: `grep -n FileArtifactStore apps/backtester/src/app.ts`); keep the `type ArtifactStore` import that other code already relies on.
- Change `import { FileBundleStore, type BundleStore } from './sandbox/bundle-store';` to `import type { BundleStore } from './sandbox/bundle-store';` **only if** `FileBundleStore` is now otherwise unused (grep: `grep -n FileBundleStore apps/backtester/src/app.ts`).

- [ ] **Step 6: Run typecheck + full app test to confirm no regression**

Run: `pnpm typecheck`
Expected: PASS (no unused-import errors).
Run: `pnpm vitest run apps/backtester/test/app.test.ts`
Expected: PASS (buildApp still constructs filesystem stores by default). If there is no `app.test.ts`, run the broader suite touching buildApp: `pnpm vitest run apps/backtester/test`.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/storage/stores.ts apps/backtester/src/app.ts apps/backtester/test/store-factory.test.ts
git commit -m "feat(storage): env-driven store factory wired into buildApp (overrides still win)"
```

---

### Task 6: Optional worker health server

**Files:**
- Create: `apps/backtester/src/jobs/worker-health.ts`
- Modify: `apps/backtester/src/worker-main.ts` (start the health server when `WORKER_HEALTH_PORT` set; SIGTERM readiness flip)
- Modify: `apps/backtester/src/config.ts` (parse `WORKER_HEALTH_PORT`)
- Test: `apps/backtester/test/worker-health.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkerHealthState { live(): boolean; ready(): boolean; }`
  - `function startWorkerHealthServer(port: number, state: WorkerHealthState): Promise<{ port: number; close(): Promise<void> }>`
  - `AppConfig.workerHealthPort?: number` (from `WORKER_HEALTH_PORT`).

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/worker-health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { startWorkerHealthServer } from '../src/jobs/worker-health';

async function statusOf(base: string, path: string): Promise<number> {
  return (await fetch(`${base}${path}`)).status;
}

describe('worker health server', () => {
  it('/healthz and /readyz reflect the state functions', async () => {
    let live = true;
    let ready = true;
    const server = await startWorkerHealthServer(0, { live: () => live, ready: () => ready });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await statusOf(base, '/healthz')).toBe(200);
      expect(await statusOf(base, '/readyz')).toBe(200);

      ready = false; // simulate SIGTERM draining: readiness drops, liveness stays up
      expect(await statusOf(base, '/readyz')).toBe(503);
      expect(await statusOf(base, '/healthz')).toBe(200);

      live = false; // loop fully resolved
      expect(await statusOf(base, '/healthz')).toBe(503);

      expect(await statusOf(base, '/nope')).toBe(404);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/worker-health.test.ts`
Expected: FAIL — cannot find module `../src/jobs/worker-health`.

- [ ] **Step 3: Write the health server**

`apps/backtester/src/jobs/worker-health.ts`:
```ts
// Optional worker health server (Kubernetes probes). Workers do not serve /v1; this is a tiny,
// isolated node:http listener. Liveness stays up during graceful drain; readiness drops on SIGTERM.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface WorkerHealthState {
  /** true while the process is alive and the drain loop has not fully resolved. */
  live(): boolean;
  /** true while the worker is accepting work (drops to false on SIGTERM/drain). */
  ready(): boolean;
}

export async function startWorkerHealthServer(
  port: number,
  state: WorkerHealthState,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(state.live() ? 200 : 503).end();
    } else if (req.url === '/readyz') {
      res.writeHead(state.ready() ? 200 : 503).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close keep-alive sockets (Node's global fetch/undici holds them) so close() resolves
        // promptly instead of blocking on keepAliveTimeout.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/worker-health.test.ts`
Expected: PASS.

- [ ] **Step 5: Parse `WORKER_HEALTH_PORT` in config**

In `apps/backtester/src/config.ts`, add to the `AppConfig` interface (next to `workerPollMs`):
```ts
  /** Optional TCP port for the worker health server (/healthz + /readyz). Unset ⇒ no server. */
  readonly workerHealthPort?: number;
```
In `loadConfig`, before `return {`:
```ts
  const workerHealthPortRaw = env.WORKER_HEALTH_PORT ? Number(env.WORKER_HEALTH_PORT) : undefined;
  const workerHealthPort =
    workerHealthPortRaw !== undefined && Number.isFinite(workerHealthPortRaw)
      ? Math.floor(workerHealthPortRaw)
      : undefined;
```
Add to the returned object literal (next to `workerPollMs: pollMs,`):
```ts
    ...(workerHealthPort !== undefined ? { workerHealthPort } : {}),
```

- [ ] **Step 6: Wire the health server into `worker-main.ts`**

In `apps/backtester/src/worker-main.ts`, add the import:
```ts
import { startWorkerHealthServer } from './jobs/worker-health.js';
```
Inside `main()`, after `const lease = ...` and before building `loop`, add:
```ts
  let loopDone = false;
  let draining = false;
  const health =
    config.workerHealthPort !== undefined
      ? await startWorkerHealthServer(config.workerHealthPort, {
          live: () => !loopDone,
          ready: () => !draining,
        })
      : undefined;
```
Change the `loop` binding so it flips `loopDone` when it resolves:
```ts
  const loop = runWorkerLoop(
    { ...deps, lease },
    {
      concurrency: config.workerConcurrency,
      heartbeatMs: config.workerHeartbeatMs,
      pollMs: config.workerPollMs,
      signal: ac.signal,
    },
  ).finally(() => {
    loopDone = true;
  });
```
Update `shutdown` to flip readiness first and close the health server last:
```ts
  const shutdown = async (): Promise<void> => {
    draining = true; // readiness → 503 immediately; liveness stays 200 during graceful drain
    ac.abort();
    await loop;
    await app.dispose();
    await health?.close();
    process.exit(0);
  };
```

- [ ] **Step 7: Typecheck + confirm worker-main still parses**

Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm vitest run apps/backtester/test/worker-health.test.ts apps/backtester/test/config-store.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/jobs/worker-health.ts apps/backtester/src/worker-main.ts apps/backtester/src/config.ts apps/backtester/test/worker-health.test.ts
git commit -m "feat(worker): optional WORKER_HEALTH_PORT (/healthz + /readyz, SIGTERM readiness flip)"
```

---

### Task 7: package.json optional dependency + Kubernetes reference manifests

**Files:**
- Modify: `apps/backtester/package.json` (add `@aws-sdk/client-s3` to `optionalDependencies`)
- Create: `deploy/k8s/examples/api-deployment.yaml`
- Create: `deploy/k8s/examples/worker-deployment.yaml`
- Create: `deploy/k8s/examples/keda-scaledobject.yaml`
- Create: `deploy/k8s/examples/minio.yaml`

**Interfaces:** none (infra artifacts). Validation is `pnpm typecheck` staying green + reviewable YAML.

- [ ] **Step 1: Add the optional dependency**

In `apps/backtester/package.json`, add a top-level block (after `dependencies`):
```json
  "optionalDependencies": {
    "@aws-sdk/client-s3": "^3.699.0"
  }
```

Then update and commit the lockfile so a frozen install (CI + the Dockerfile's first
install) does not fail with `ERR_PNPM_OUTDATED_LOCKFILE`:

Run: `pnpm install` (regenerates `pnpm-lock.yaml` — additive: the `@aws-sdk/client-s3` tree)
Verify: `pnpm install --frozen-lockfile --ignore-scripts` — Expected: PASS (no `ERR_PNPM_OUTDATED_LOCKFILE`)
Commit `pnpm-lock.yaml` together with `package.json`. (`@aws-sdk/client-s3` in `optionalDependencies`
IS installed by pnpm on a normal install; the widened dynamic import keeps it out of the compile-time
graph, and the default `filesystem` backend never uses it.)

- [ ] **Step 2: Write `deploy/k8s/examples/api-deployment.yaml`**

```yaml
# Reference only — copy and adapt; not a production Helm chart.
# API node: serves /v1 + GET /health; the in-process worker is OFF (BACKTESTER_AUTO_WORKER=false).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backtester-api
spec:
  replicas: 2
  selector:
    matchLabels: { app: backtester-api }
  template:
    metadata:
      labels: { app: backtester-api }
    spec:
      containers:
        - name: api
          image: trading-backtester:latest
          command: ["node_modules/.bin/tsx", "apps/backtester/src/index.ts"]
          ports:
            - containerPort: 8080
          env:
            - name: BACKTESTER_AUTO_WORKER
              value: "false"
            - name: BACKTESTER_PORT
              value: "8080"
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: backtester-db, key: url } }
            - name: BACKTESTER_STORE_BACKEND
              value: "s3"
            - name: BACKTESTER_S3_ENDPOINT
              value: "http://minio:9000"
            - name: BACKTESTER_S3_BUCKET
              value: "backtester"
            - name: BACKTESTER_S3_FORCE_PATH_STYLE
              value: "true"
            - name: BACKTESTER_S3_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: backtester-s3, key: accessKey } }
            - name: BACKTESTER_S3_SECRET_KEY
              valueFrom: { secretKeyRef: { name: backtester-s3, key: secretKey } }
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: backtester-api
spec:
  selector: { app: backtester-api }
  ports:
    - port: 8080
      targetPort: 8080
```

- [ ] **Step 3: Write `deploy/k8s/examples/worker-deployment.yaml`**

```yaml
# Reference only. Worker node: drains the shared Postgres queue (no HTTP /v1). KEDA scales replicas.
# Prefer low WORKER_CONCURRENCY and more pods (see docs/OPERATIONS.md capacity budget).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backtester-worker
spec:
  replicas: 1 # KEDA overrides this; see keda-scaledobject.yaml
  selector:
    matchLabels: { app: backtester-worker }
  template:
    metadata:
      labels: { app: backtester-worker }
    spec:
      terminationGracePeriodSeconds: 7200 # allow an in-flight backtest to drain
      containers:
        - name: worker
          image: trading-backtester:latest
          command: ["node_modules/.bin/tsx", "apps/backtester/src/worker-main.ts"]
          ports:
            - containerPort: 8081
          env:
            - name: WORKER_CONCURRENCY
              value: "2"
            - name: WORKER_HEALTH_PORT
              value: "8081"
            - name: WORKER_ID
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: backtester-db, key: url } }
            - name: BACKTESTER_STORE_BACKEND
              value: "s3"
            - name: BACKTESTER_S3_ENDPOINT
              value: "http://minio:9000"
            - name: BACKTESTER_S3_BUCKET
              value: "backtester"
            - name: BACKTESTER_S3_FORCE_PATH_STYLE
              value: "true"
            - name: BACKTESTER_S3_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: backtester-s3, key: accessKey } }
            - name: BACKTESTER_S3_SECRET_KEY
              valueFrom: { secretKeyRef: { name: backtester-s3, key: secretKey } }
          readinessProbe:
            httpGet: { path: /readyz, port: 8081 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: 8081 }
            periodSeconds: 10
          resources:
            # Budget = WORKER_CONCURRENCY × avg_symbols_per_run × sandbox limits (see OPERATIONS.md).
            requests: { cpu: "2", memory: "1Gi" }
            limits: { cpu: "4", memory: "2Gi" }
```

- [ ] **Step 4: Write `deploy/k8s/examples/keda-scaledobject.yaml`**

```yaml
# Reference only. KEDA scales the worker Deployment from Postgres queue depth. DB creds go through a
# Secret referenced by TriggerAuthentication — NEVER plaintext in the ScaledObject.
apiVersion: v1
kind: Secret
metadata:
  name: keda-backtester-db
type: Opaque
stringData:
  connection: "postgresql://user:pass@postgres:5432/backtester?sslmode=disable" # from your secret manager
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: keda-backtester-db-auth
spec:
  secretTargetRef:
    - parameter: connection
      name: keda-backtester-db
      key: connection
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: backtester-worker
spec:
  scaleTargetRef:
    name: backtester-worker
  minReplicaCount: 0
  maxReplicaCount: 10 # cap from the capacity budget in docs/OPERATIONS.md
  triggers:
    - type: postgresql
      metadata:
        query: "SELECT count(*) FROM backtest_job WHERE status = 'queued'"
        targetQueryValue: "3" # desired queued jobs per replica
        activationTargetQueryValue: "0"
      authenticationRef:
        name: keda-backtester-db-auth
```

- [ ] **Step 5: Write `deploy/k8s/examples/minio.yaml`**

```yaml
# Reference only — the first-class self-hosted S3-compatible target. Swap for a managed S3 by
# pointing BACKTESTER_S3_ENDPOINT at it and setting BACKTESTER_S3_FORCE_PATH_STYLE=false.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
spec:
  replicas: 1
  selector:
    matchLabels: { app: minio }
  template:
    metadata:
      labels: { app: minio }
    spec:
      containers:
        - name: minio
          image: minio/minio:latest
          args: ["server", "/data", "--console-address", ":9001"]
          ports:
            - containerPort: 9000
            - containerPort: 9001
          env:
            - name: MINIO_ROOT_USER
              valueFrom: { secretKeyRef: { name: backtester-s3, key: accessKey } }
            - name: MINIO_ROOT_PASSWORD
              valueFrom: { secretKeyRef: { name: backtester-s3, key: secretKey } }
---
apiVersion: v1
kind: Service
metadata:
  name: minio
spec:
  selector: { app: minio }
  ports:
    - name: s3
      port: 9000
      targetPort: 9000
```

- [ ] **Step 6: Typecheck (ensure the package.json edit is valid) + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add apps/backtester/package.json deploy/k8s/examples/
git commit -m "feat(deploy): k8s/KEDA reference manifests + @aws-sdk/client-s3 optional dep"
```

---

### Task 8: OPERATIONS + ROADMAP docs

**Files:**
- Modify: `docs/OPERATIONS.md` (append a "Horizontal scaling (Phase C foundation)" section)
- Modify: `docs/ROADMAP.md` (mark Phase C items 6–9 as covered by this foundation)

**Interfaces:** none (docs). Validate by eye + `pnpm typecheck` unaffected.

- [ ] **Step 1: Append the horizontal-scaling section to `docs/OPERATIONS.md`**

Add at the end of `docs/OPERATIONS.md`:
```markdown
## Horizontal scaling (Phase C foundation)

Split API and workers, share the queue (Postgres) and object store (S3-compatible), and let KEDA
scale workers from queue depth. Reference manifests: [`deploy/k8s/examples/`](../deploy/k8s/examples/).

### Deployment split
- **API node:** `BACKTESTER_AUTO_WORKER=false`; readiness/liveness `GET /health`.
- **Worker nodes:** run `worker-main.ts`; require `DATABASE_URL`; set a unique `WORKER_ID` (pod name),
  low `WORKER_CONCURRENCY` (1–2), and `WORKER_HEALTH_PORT` for `/healthz` (liveness) + `/readyz`
  (readiness; drops to 503 on SIGTERM during graceful drain).

### Object store (S3-compatible — MinIO first-class)
Set `BACKTESTER_STORE_BACKEND=s3` and:

| Env | MinIO (first-class) | AWS S3 |
|---|---|---|
| `BACKTESTER_S3_ENDPOINT` | `http://minio:9000` | regional endpoint |
| `BACKTESTER_S3_BUCKET` | `backtester` | your bucket |
| `BACKTESTER_S3_REGION` | any (e.g. `us-east-1`) | the bucket region |
| `BACKTESTER_S3_ACCESS_KEY` / `_SECRET_KEY` | from `Secret` | from `Secret` |
| `BACKTESTER_S3_FORCE_PATH_STYLE` | `true` | `false` |

`S3` here means the S3 **protocol/API**, not the AWS vendor — the same code runs against MinIO, Ceph
RGW, Cloudflare R2, or AWS S3. Default backend is `filesystem` (dev/CI). `@aws-sdk/client-s3` is an
optional dependency imported only on the S3 path.

### KEDA scaling
Scale the worker Deployment with a KEDA `ScaledObject` on queue depth
(`SELECT count(*) FROM backtest_job WHERE status = 'queued'`). DB credentials go through a
`TriggerAuthentication` + `Secret`, never plaintext. Use `ScaledObject` (long-lived worker), **not**
`ScaledJob` — that needs a worker-once mode we have not built.

### Capacity budget
Sandbox sessions are per module+symbol on each node's Docker daemon. Size and cap replicas with:

```
peak sandbox memory ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_memory_mb
peak sandbox CPU    ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_cpus
```

Prefer many modest workers over few large ones, and set KEDA `maxReplicaCount` from these formulas so
you do not exhaust a node's Docker daemon.
```

- [ ] **Step 2: Update `docs/ROADMAP.md` Phase C**

In `docs/ROADMAP.md`, under `### Phase C — throughput and multi-tenant scaling`, add this line immediately after the "Detailed analysis and decision context" line:
```markdown

**Foundation (items 6–9) — design + plan landed:** see
[`specs/2026-07-01-backtester-throughput-scaling-foundation-design.md`](superpowers/specs/2026-07-01-backtester-throughput-scaling-foundation-design.md)
and [`plans/2026-07-01-backtester-throughput-scaling-foundation.md`](superpowers/plans/2026-07-01-backtester-throughput-scaling-foundation.md):
S3-compatible shared store (MinIO first-class), first-class API/worker split with worker health
probes, and K8s/KEDA reference manifests. Items 10–13 (quotas, dedup, stronger sandbox, Temporal)
remain follow-up specs.
```

- [ ] **Step 3: Verify links + no typecheck regression**

Run: `pnpm typecheck`
Expected: PASS.
Confirm the two relative doc links resolve (design spec + this plan exist under `docs/superpowers/`).

- [ ] **Step 4: Commit**

```bash
git add docs/OPERATIONS.md docs/ROADMAP.md
git commit -m "docs(phase-c): horizontal-scaling ops guide + ROADMAP foundation pointer"
```

---

### Task 9: Full-suite green + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full check**

Run: `pnpm check`
Expected: PASS — `typecheck` clean and the full vitest suite green (existing tests + the 4 new test files). No golden/result-hash fixtures changed.

- [ ] **Step 2: If anything fails, fix forward**

Investigate with systematic-debugging; do not weaken any assertion or invariant to make it pass. Re-run `pnpm check` until green, committing each fix with a descriptive message.

---

## Self-Review

**Spec coverage:**
- §6.1 S3 client port + dynamic import + fail-fast → Task 1.
- §6.2 S3ArtifactStore / S3BundleStore, key layout, idempotent overwrite, hash equality → Tasks 2, 3 (determinism cases pin hash equality).
- §6.3 config `storeBackend` + `s3` + factory + `buildApp` wiring → Tasks 4, 5.
- §7 worker health endpoint (/healthz + /readyz, SIGTERM flip, unset ⇒ no server) → Task 6.
- §8 K8s/KEDA reference manifests (Secret + TriggerAuthentication) + MinIO + OPERATIONS capacity formulas → Tasks 7, 8.
- §9 testing (conformance via fake client, hash-equality/determinism, factory config, worker health, `assertWorkerConfig` already exists) → Tasks 1–6, 9.
- §10 deliverables incl. `@aws-sdk/client-s3` optional dep, ROADMAP update → Tasks 7, 8.
- Invariants (§3): no sandbox files touched; `result_hash` guarded by determinism cross-checks; queue untouched — held across all tasks.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every command has expected output.

**Type consistency:** `S3ObjectClient.{put,get,head}`, `createS3ObjectClient`, `createFakeS3Client`, `S3ArtifactStore`/`S3BundleStore` constructors (single `S3ObjectClient` arg), `createArtifactStore`/`createBundleStore(config, injected?)`, `WorkerHealthState.{live,ready}`, `startWorkerHealthServer(port, state)`, and `AppConfig.{storeBackend,s3,workerHealthPort}` are used identically across the tasks that define and consume them.

**Note for the implementer (Task 5, Step 5):** grep before narrowing the `app.ts` imports — `FileArtifactStore` / `FileBundleStore` may still be referenced elsewhere in the file; only convert to `type`-only import if the value import is genuinely unused, else leave it and just add the factory import.

---

## Post-review hardening (applied after the whole-branch review — commit 6906b23)

The final whole-branch review passed (merge = yes). Three agreed hardening deltas were applied on top of the tasks above:

1. `config.ts` — reject a set-but-unrecognized `BACKTESTER_STORE_BACKEND` (fail-fast) instead of silently defaulting to `filesystem`; an unset/empty value still defaults to filesystem. (+2 `config-store.test.ts` cases.)
2. `buildApp` — construct a single shared `S3ObjectClient` for the artifact and bundle stores instead of one each (one connection pool).
3. `docs/OPERATIONS.md` — note that the bucket must be created first (`mc mb`).

Accepted as **fast-follows** (non-blocking): a `HeadBucket` preflight to tighten the not-found taxonomy, a MinIO integration test exercising the real client, `hexOf`/`JSON.parse` cross-impl consistency across the store adapters, `WORKER_HEALTH_PORT="0"` disable semantics, a k8s `Service` for the worker health port, and MinIO bucket auto-create.
