# Phase A — Real Platform Data Path (finish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backtester's real `trading-platform` historical data path a first-class, safe, tested production posture (distinct `'real'` config, fail-fast validation, normalized failure cause, opt-in real-platform E2E gate) — closing roadmap Phase A.

**Architecture:** Single-repo slice in `apps/backtester`. `'real'` gets its own `BACKTESTER_REAL_PLATFORM_URL/_TOKEN` pair; `loadConfig` fail-fasts when `dataSource=real` lacks them; `app.ts` selects `RowsDataPort` on the real pair; `RowsDataPort.openDataset` stops swallowing failures and throws a normalized `RealDataUnavailableError` that the worker maps to terminal `missing_dataset` with a fixed `errorDetail` string; the existing cross-repo E2E is extended to exercise `'real'` with a closed-window determinism assertion.

**Tech Stack:** TypeScript, Vitest, Fastify (test fixture server), `@trading-platform/sdk/historical` (`HistoricalClient`), Postgres/InMemory job stores.

## Global Constraints

- **No contract change.** `RowsDataPort` keeps consuming `historical.2`. No changes to `trading-platform` or `@trading-backtester/sdk`.
- **Code-default stays `fixture`.** `'real'` is a production posture, never the code default.
- **No new terminal-code taxonomy.** Reuse `missing_dataset`.
- **`errorDetail` fixed string contract:** `cause=<cause>; datasetRef=<datasetRef>` where `<cause>` ∈ { `unauthorized`, `connection_refused`, `contract_version_mismatch`, `rows_resource_unavailable`, `dataset_not_found`, `discover_failed` }. No tokens/secrets, no stack, no raw lower-layer text.
- **Byte-identity:** fixture / mock / success paths unchanged. Only the real-failure path adds a cause.
- **No retry/backoff, no bounded HTTP timeout** (lean).
- **Reference data-API server out of scope.** `createDataApiServer` / `data-api-server.ts` (the `/data/v1/*` dev/parity surface) is only ever constructed with `FixtureDataPort` (`data-api-main.ts` hardcodes it), whose `openDataset` still returns `undefined`→404 (unchanged by this slice). `RowsDataPort` is a *consumer* of this contract, never fronted by the reference server, so the new `openDataset` throw cannot reach its `!reader`→404 path — no mapping needed. Do NOT front a `RowsDataPort` with this server (double-hop, unsupported).
- **TDD:** every production change has a failing test first. Test command from repo root: `pnpm test <pattern>`. Typecheck: `pnpm typecheck`. Full gate: `pnpm check`.

---

### Task 1: Config — real platform pair + fail-fast validation

**Files:**
- Modify: `apps/backtester/src/config.ts` (the `AppConfig` interface + `loadConfig`, around lines 100–296)
- Test: `apps/backtester/test/config-real-platform.test.ts` (create)

**Interfaces:**
- Consumes: existing `loadConfig(env)` → `AppConfig`; existing `AppConfig` fields `dataSource`, `mockPlatformUrl?`, `mockPlatformToken?`.
- Produces: `AppConfig` gains `realPlatformUrl?: string` and `realPlatformToken?: string`. `loadConfig` throws `Error` with message `BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real` when `dataSource==='real'` and either value is missing / empty / whitespace-only.

- [ ] **Step 1: Write the failing tests**

Create `apps/backtester/test/config-real-platform.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const BASE = { BACKTESTER_DATA_SOURCE: 'real' } as NodeJS.ProcessEnv;

describe('loadConfig real-platform validation', () => {
  it('throws a stable error when real is selected without URL/token', () => {
    expect(() => loadConfig({ ...BASE }))
      .toThrow('BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real');
  });

  it('throws when URL present but token missing', () => {
    expect(() => loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: 'http://127.0.0.1:8088' }))
      .toThrow('BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real');
  });

  it('treats whitespace-only URL/token as misconfig', () => {
    expect(() => loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: '  ', BACKTESTER_REAL_PLATFORM_TOKEN: '\t' }))
      .toThrow('required when BACKTESTER_DATA_SOURCE=real');
  });

  it('loads a fully-configured real source', () => {
    const cfg = loadConfig({ ...BASE, BACKTESTER_REAL_PLATFORM_URL: 'http://127.0.0.1:8088', BACKTESTER_REAL_PLATFORM_TOKEN: 'raw-secret' });
    expect(cfg.dataSource).toBe('real');
    expect(cfg.realPlatformUrl).toBe('http://127.0.0.1:8088');
    expect(cfg.realPlatformToken).toBe('raw-secret');
  });

  it('does not validate real vars when data source is not real', () => {
    expect(() => loadConfig({ BACKTESTER_DATA_SOURCE: 'fixture' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test config-real-platform`
Expected: FAIL — `loadConfig` does not throw / `realPlatformUrl` is undefined (property not yet added).

- [ ] **Step 3: Add the config fields + validation**

In `apps/backtester/src/config.ts`, add to the `AppConfig` interface (near `mockPlatformUrl?`/`mockPlatformToken?`):

```typescript
  readonly realPlatformUrl?: string;
  readonly realPlatformToken?: string;
```

In `loadConfig`, compute the raw real vars and validate BEFORE the `return` object (mirroring the existing `store backend 's3' requires …` fail-fast pattern). Insert just before the `return {` at the end of `loadConfig`:

```typescript
  const realPlatformUrl = env.BACKTESTER_REAL_PLATFORM_URL;
  const realPlatformToken = env.BACKTESTER_REAL_PLATFORM_TOKEN;
  const dataSourceResolved =
    env.BACKTESTER_DATA_SOURCE === 'http' ? 'http' :
    env.BACKTESTER_DATA_SOURCE === 'mock' ? 'mock' :
    env.BACKTESTER_DATA_SOURCE === 'real' ? 'real' : 'fixture';
  if (dataSourceResolved === 'real' && (!realPlatformUrl?.trim() || !realPlatformToken?.trim())) {
    throw new Error(
      'BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real',
    );
  }
```

Then in the returned object, replace the inline `dataSource:` ternary with `dataSource: dataSourceResolved,` and add the two conditional fields next to the mock ones:

```typescript
    ...(realPlatformUrl   ? { realPlatformUrl }   : {}),
    ...(realPlatformToken ? { realPlatformToken } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test config-real-platform`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-real-platform.test.ts
git commit -m "feat(config): real-platform URL/token pair + fail-fast validation"
```

---

### Task 2: Factory — `'real'` selects RowsDataPort on the real pair

**Files:**
- Modify: `apps/backtester/src/app.ts` (data-port factory, around lines 88–102)
- Test: `apps/backtester/test/app-datasource-factory.test.ts` (create)

**Interfaces:**
- Consumes: `AppConfig.realPlatformUrl/realPlatformToken` (Task 1), existing `RowsDataPort` (constructor `RowsDataPortOptions { baseUrl, token?, pageLimit?, fetchImpl? }`).
- Produces: for `dataSource==='real'` the factory constructs `RowsDataPort` bound to the **real** pair; `'mock'` stays on the mock pair.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/app-datasource-factory.test.ts`. The factory is internal to `buildApp`, so assert behaviour via the constructed data port's `listDatasets`/`openDataset` target. Use a Fastify historical.2 fixture on a known port and assert the `'real'` app reaches the REAL url, not the mock one:

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

function historical2Server(symbols: string[]): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/historical/discover', (_r, reply) => reply.send({
    historicalContractVersion: 'historical.2',
    capabilities: { readOnly: true, execution: false, mutation: false, liveIngestion: false },
    resources: [{ name: 'rows', availability: 'available', supportedFilters: ['symbols','fromMs','toMs'], pagination: { cursor: true, maxPageItems: 100 }, fields: [] }],
    symbols, timeframes: ['1m'],
  }));
  // NB: listDatasets() filters `availability==='available' && barCount>0`, so coverage MUST report a
  // non-empty dataset or the assertion is a false red (empty regardless of the real-branch fix).
  app.get('/historical/coverage', (_r, reply) => reply.send({ entries: symbols.map(s => ({ symbol: s, timeframe: '1m', fromMs: 0, toMs: 300_000, barCount: 6, availability: 'available' })), symbols, timeframes: ['1m'], availability: 'available', asOf: 0 }));
  app.get('/historical/rows', (_r, reply) => reply.send({ items: [], nextCursor: null, asOf: 0, window: {}, freshness: 'fresh' }));
  return app;
}

describe('buildApp data-source factory', () => {
  let realSrv: FastifyInstance, mockSrv: FastifyInstance, realUrl: string, mockUrl: string;
  beforeAll(async () => {
    realSrv = historical2Server(['REALSYM']); realUrl = await realSrv.listen({ host: '127.0.0.1', port: 0 });
    mockSrv = historical2Server(['MOCKSYM']); mockUrl = await mockSrv.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => { await realSrv.close(); await mockSrv.close(); });

  it("dataSource=real opens datasets from the REAL pair, not the mock pair", async () => {
    const cfg = loadConfig({
      BACKTESTER_DATA_SOURCE: 'real',
      BACKTESTER_REAL_PLATFORM_URL: realUrl, BACKTESTER_REAL_PLATFORM_TOKEN: 'real-tok',
      BACKTESTER_MOCK_PLATFORM_URL: mockUrl, BACKTESTER_MOCK_PLATFORM_TOKEN: 'mock-tok',
    });
    const app = await buildApp(cfg);
    const datasets = await app.deps.dataPort.listDatasets();
    expect(datasets.map(d => d.datasetRef)).toContain('REALSYM:1m');
    expect(datasets.map(d => d.datasetRef)).not.toContain('MOCKSYM:1m');
    await app.close?.();
  });
});
```

> NOTE: confirm the `buildApp` return exposes `deps.dataPort` and a `close`; if the accessor differs, mirror what `apps/backtester/test/helpers.ts` uses to reach the built data port. Adjust the two accessor lines only — the assertion intent (real url wins) is fixed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app-datasource-factory`
Expected: FAIL — `'real'` currently falls through to `config.mockPlatformUrl` (the RowsDataPort points at the MOCK server), so `listDatasets` returns `MOCKSYM:1m`.

- [ ] **Step 3: Split the `'real'` branch in the factory**

In `apps/backtester/src/app.ts`, replace the combined branch:

```typescript
      : (config.dataSource === 'mock' || config.dataSource === 'real') && config.mockPlatformUrl
      ? new RowsDataPort({
          baseUrl:   config.mockPlatformUrl,
          pageLimit: config.dataApiPageLimit,
          ...(config.mockPlatformToken ? { token: config.mockPlatformToken } : {}),
        })
```

with two explicit branches (real first):

```typescript
      : config.dataSource === 'real' && config.realPlatformUrl
      ? new RowsDataPort({
          baseUrl:   config.realPlatformUrl,
          pageLimit: config.dataApiPageLimit,
          ...(config.realPlatformToken ? { token: config.realPlatformToken } : {}),
        })
      : config.dataSource === 'mock' && config.mockPlatformUrl
      ? new RowsDataPort({
          baseUrl:   config.mockPlatformUrl,
          pageLimit: config.dataApiPageLimit,
          ...(config.mockPlatformToken ? { token: config.mockPlatformToken } : {}),
        })
```

(The `realPlatformUrl` presence is guaranteed by Task 1 validation when `dataSource==='real'`; the `&& config.realPlatformUrl` guard keeps the type narrowing.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app-datasource-factory`
Expected: PASS. Also run `pnpm test helpers overlay-gating registry-endpoint` to confirm the mock path is unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/test/app-datasource-factory.test.ts
git commit -m "feat(app): dataSource=real selects RowsDataPort on the real platform pair"
```

---

### Task 3: Normalized failure cause — `RealDataUnavailableError` from `openDataset`

**Files:**
- Modify: `apps/backtester/src/data/rows-data-port.ts` (add error type + rewrite `openDataset` failure paths, around lines 103–126)
- Test: `apps/backtester/test/rows-data-port.test.ts` (update the 5 undefined-expecting cases + add auth/connection cases)

**Interfaces:**
- Produces (exported from `rows-data-port.ts`):
  - `type RealDataCause = 'unauthorized' | 'connection_refused' | 'contract_version_mismatch' | 'rows_resource_unavailable' | 'dataset_not_found' | 'discover_failed'`
  - `class RealDataUnavailableError extends Error { readonly reason: RealDataCause; readonly datasetRef: string }` whose `message` is exactly `cause=<reason>; datasetRef=<datasetRef>`.
- Behaviour: `openDataset` returns a reader on success, returns `undefined` ONLY for a malformed ref (no colon / empty side — caller bug, unchanged), and THROWS `RealDataUnavailableError` for every platform-side failure.

- [ ] **Step 1: Update the failing tests**

In `apps/backtester/test/rows-data-port.test.ts`, change the five `toBeUndefined()` platform-failure cases to expect the thrown cause, and add two new cases. Import the error type at the top:

```typescript
import { RowsDataPort, RealDataUnavailableError } from '../src/data/rows-data-port';
```

Replace the bodies of these existing `it(...)`s inside `describe('openDataset()')`:

```typescript
    it('throws dataset_not_found for unknown timeframe', async () => {
      const port = new RowsDataPort({ baseUrl });
      await expect(port.openDataset('BTCUSDT:5m')).rejects.toMatchObject({ reason: 'dataset_not_found', datasetRef: 'BTCUSDT:5m' });
    });

    it('throws dataset_not_found for unknown symbol', async () => {
      const port = new RowsDataPort({ baseUrl });
      await expect(port.openDataset('ETHUSDT:1m')).rejects.toBeInstanceOf(RealDataUnavailableError);
    });

    it('keeps returning undefined for malformed ref (no colon) — caller bug, not a platform failure', async () => {
      const port = new RowsDataPort({ baseUrl });
      expect(await port.openDataset('BTCUSDT1m')).toBeUndefined();
    });
```

Replace the three server-variant cases (`contractVersion: 'historical.1'`, `rowsAvailability: 'unavailable'`, `omitRowsResource: true`) to assert the mapped cause, e.g.:

```typescript
    it('throws contract_version_mismatch when contract is not historical.2', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = buildFixtureServer({ contractVersion: 'historical.1' });
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        await expect(new RowsDataPort({ baseUrl: url }).openDataset('BTCUSDT:1m'))
          .rejects.toMatchObject({ reason: 'contract_version_mismatch' });
      } finally { await s?.close(); }
    });
    // ... rowsAvailability:'unavailable' AND omitRowsResource:true → reason: 'rows_resource_unavailable'
```

Add two new cases (auth + connectivity):

```typescript
    it('throws unauthorized on a 401 from the historical API', async () => {
      let s: FastifyInstance | undefined;
      try {
        s = Fastify({ logger: false });
        s.get('/historical/discover', (_r, reply) => reply.code(401).send({ error: 'unauthorized' }));
        const url = await s.listen({ host: '127.0.0.1', port: 0 });
        await expect(new RowsDataPort({ baseUrl: url, token: 'bad' }).openDataset('BTCUSDT:1m'))
          .rejects.toMatchObject({ reason: 'unauthorized' });
      } finally { await s?.close(); }
    });

    it('throws connection_refused when the endpoint is unreachable', async () => {
      // 127.0.0.1:1 is reserved/closed → ECONNREFUSED
      await expect(new RowsDataPort({ baseUrl: 'http://127.0.0.1:1' }).openDataset('BTCUSDT:1m'))
        .rejects.toMatchObject({ reason: 'connection_refused' });
    });
```

(Also fix the message format assertion if any test reads `.message` — it is now `cause=<reason>; datasetRef=<ref>`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test rows-data-port`
Expected: FAIL — `openDataset` still returns `undefined` (rejects assertions fail); `RealDataUnavailableError` is not exported.

- [ ] **Step 3: Add the error type + rewrite `openDataset`**

In `apps/backtester/src/data/rows-data-port.ts`, add near the top (after imports):

```typescript
export type RealDataCause =
  | 'unauthorized'
  | 'connection_refused'
  | 'contract_version_mismatch'
  | 'rows_resource_unavailable'
  | 'dataset_not_found'
  | 'discover_failed';

/** Thrown by RowsDataPort.openDataset on any platform-side failure. `message` is the fixed
 *  errorDetail string contract: `cause=<reason>; datasetRef=<datasetRef>`. */
export class RealDataUnavailableError extends Error {
  constructor(readonly reason: RealDataCause, readonly datasetRef: string) {
    super(`cause=${reason}; datasetRef=${datasetRef}`);
    this.name = 'RealDataUnavailableError';
  }
}

/** Normalize a discover() failure into a finite cause. Raw SDK/Node text never surfaces. */
function classifyDiscoverError(err: unknown): RealDataCause {
  const anyErr = err as { status?: number; statusCode?: number; code?: string; cause?: { code?: string }; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  if (status === 401 || status === 403) return 'unauthorized';
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : '';
  if (/\b40[13]\b/.test(msg)) return 'unauthorized';
  const netCode = anyErr?.code ?? anyErr?.cause?.code;
  if (netCode === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'connection_refused';
  return 'discover_failed';
}
```

Rewrite the failure paths of `openDataset` (keep the malformed-ref `return undefined`, replace every other `return undefined` with a throw):

```typescript
  async openDataset(ref: string): Promise<HistoricalDatasetReader | undefined> {
    const colonIdx = ref.indexOf(':');
    if (colonIdx <= 0) return undefined;
    const symbol = ref.slice(0, colonIdx);
    const timeframe = ref.slice(colonIdx + 1);
    if (!symbol || !timeframe) return undefined;

    let descriptor;
    try {
      descriptor = await this.client.discover();
    } catch (err) {
      throw new RealDataUnavailableError(classifyDiscoverError(err), ref);
    }
    if (descriptor.historicalContractVersion !== 'historical.2') {
      throw new RealDataUnavailableError('contract_version_mismatch', ref);
    }
    const rowsResource = descriptor.resources.find((r) => r.name === 'rows');
    if (!rowsResource || rowsResource.availability !== 'available') {
      throw new RealDataUnavailableError('rows_resource_unavailable', ref);
    }
    if (!descriptor.symbols.includes(symbol) || !descriptor.timeframes.includes(timeframe)) {
      throw new RealDataUnavailableError('dataset_not_found', ref);
    }
    return new RowsReader(this.client, symbol);
  }
```

> NOTE: confirm the `HistoricalClient.discover()` error shape during impl. If the SDK exposes the HTTP status differently than `status`/`statusCode`/message-substring, extend `classifyDiscoverError` accordingly; `discover_failed` is the safe fallback. The `unauthorized` and `connection_refused` tests pin the required behaviour.

> NOTE (contract-width): this changes `openDataset` from "undefined on platform failure" to "throw with a cause" **for `RowsDataPort` only**. The only other consumer of `openDataset`-returns-undefined via the `!reader`→404 path is `data-api-server.ts`, which is out of scope (see Global Constraints — it only ever wraps `FixtureDataPort`, unchanged). `buildOverlayDataset` (the real consumer) already propagates a throw cleanly (no try/catch), so the throw reaches the worker catch (Task 4). No other caller relies on the undefined-on-failure behaviour.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test rows-data-port`
Expected: PASS (all cases incl. the multi-symbol test from #89 and the new cause cases).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/data/rows-data-port.ts apps/backtester/test/rows-data-port.test.ts
git commit -m "feat(data): RowsDataPort surfaces a normalized failure cause (RealDataUnavailableError)"
```

---

### Task 4: Worker — map `RealDataUnavailableError` to `missing_dataset` + fixed detail

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (the `catch (err)` in `processNextQueued`, around line 654)
- Test: `apps/backtester/test/worker-real-data-detail.test.ts` (create)

**Interfaces:**
- Consumes: `RealDataUnavailableError` (Task 3), existing `boundedErrorDetail(err)`, existing terminal-code assignment.
- Produces: a run whose materialize hits a real-platform failure terminates with `terminalCode: 'missing_dataset'` and `errorDetail` equal to the error's fixed string `cause=<cause>; datasetRef=<ref>`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/worker-real-data-detail.test.ts`. Drive one job through the worker with a `dataPort` override whose `openDataset` throws `RealDataUnavailableError`, then assert the terminal row:

```typescript
import { describe, it, expect } from 'vitest';
import { RealDataUnavailableError } from '../src/data/rows-data-port';
// Reuse the harness used by worker-error-visibility.test.ts to build a worker + submit one job.
// (Mirror that test's setup: InMemory store, a throwingDataPort override, engine:'strategy'.)

describe('worker maps RealDataUnavailableError', () => {
  it('terminates missing_dataset with the fixed cause detail', async () => {
    const dataPort = {
      listDatasets: async () => [],
      openDataset: async (_ref: string) => { throw new RealDataUnavailableError('unauthorized', 'BTCUSDT:1m'); },
    };
    const finished = await runOneJob({ dataPort, request: strategyRequest(['BTCUSDT']) }); // helper per worker-error-visibility.test.ts
    expect(finished?.status).toBe('failed');
    expect(finished?.terminalCode).toBe('missing_dataset');
    expect(finished?.errorDetail).toBe('cause=unauthorized; datasetRef=BTCUSDT:1m');
  });
});
```

> NOTE: `runOneJob`/`strategyRequest` are illustrative — build the worker + submit exactly as `apps/backtester/test/worker-error-visibility.test.ts` does (that test already exercises `buildOverlayDataset: unknown dataset` through the worker with a throwing data port). Read it first and mirror its harness; the assertions above are the fixed part. If `errorDetail` is not projected onto the terminal row today, assert it via the `job_terminal` console line the way that test captures worker output.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test worker-real-data-detail`
Expected: FAIL — `terminalCode` is `runner_failure` (RealDataUnavailableError is not a `RunnerError`), and `errorDetail` is the raw bounded message rather than the asserted fixed string only if code differs — the code mismatch fails first.

- [ ] **Step 3: Extend the terminal-code mapping**

In `apps/backtester/src/jobs/worker.ts`, import the error at the top:

```typescript
import { RealDataUnavailableError } from '../data/rows-data-port';
```

In the `catch (err)` block of `processNextQueued`, extend the `code` assignment (currently `const code = err instanceof RunnerError ? err.code : 'runner_failure';`):

```typescript
    const code = err instanceof RunnerError
      ? err.code
      : err instanceof RealDataUnavailableError
      ? 'missing_dataset'
      : 'runner_failure';
```

`caughtErrorDetail = boundedErrorDetail(err)` is unchanged: `RealDataUnavailableError.message` is already the fixed `cause=…; datasetRef=…` string, so `errorDetail` flows through automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test worker-real-data-detail`
Expected: PASS. Also run `pnpm test worker-error-visibility` to confirm the generic path is unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/worker-real-data-detail.test.ts
git commit -m "feat(worker): map RealDataUnavailableError to missing_dataset + fixed cause detail"
```

---

### Task 5: Real-platform E2E gate — extend cross-repo test (opt-in, closed-window determinism)

**Files:**
- Modify: `apps/backtester/test/cross-repo-historical-e2e.integration.test.ts`

**Interfaces:**
- Consumes: the existing platform-spawn harness in this test (spawns `start-historical-http` from the sibling `trading-platform` checkout; gated by `RUN_CROSS_REPO_E2E=true`), `buildApp`, `loadConfig`, the run-submit + poll helpers already in the file.
- Produces: two new assertions — a `'real'`-configured multi-symbol run completes, and two identical closed-window runs yield an identical `datasetFingerprint`/`resultHash`.

- [ ] **Step 1: Write the failing (opt-in) test additions**

Read the existing test first. Add a block that builds the backtester with the **real** config pointed at the spawned server, then runs single- and multi-symbol closed-window cases twice each and compares fingerprints/hashes:

```typescript
// Closed window + symbol set are DERIVED from the spawned server's coverage — NEVER hardcoded.
// The sibling trading-platform fixture corpus is not guaranteed to hold specific symbols/dates,
// so hardcoding would make the gate environment-specific/flaky.
const TF = '1m';
const MARGIN_MS = 2 * 60_000; // trim below max toMs → exclude any still-forming tail bar (closed window)

async function pickClosedWindow(baseUrl: string, token: string, n: number):
  Promise<{ symbols: string[]; from: string; to: string } | undefined> {
  const res = await fetch(`${baseUrl}/historical/coverage`, { headers: { authorization: `Bearer ${token}` } });
  const cov = await res.json() as { entries: Array<{ symbol: string; timeframe: string; fromMs: number; toMs: number; barCount: number; availability: string }> };
  const usable = cov.entries
    .filter(e => e.timeframe === TF && e.availability === 'available' && e.barCount > 0)
    .slice(0, n);
  if (usable.length < n) return undefined; // corpus too small → caller skips (logged)
  const from = Math.max(...usable.map(e => e.fromMs));
  const to   = Math.min(...usable.map(e => e.toMs)) - MARGIN_MS;
  return { symbols: usable.map(e => e.symbol), from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function realCfg(baseUrl: string, token: string) {
  return loadConfig({
    BACKTESTER_DATA_SOURCE: 'real',
    BACKTESTER_REAL_PLATFORM_URL: baseUrl,
    BACKTESTER_REAL_PLATFORM_TOKEN: token,
    // plus whatever store/sandbox env this test already sets
  });
}

it('real platform: multi-symbol run is deterministic across two identical closed-window runs', async () => {
  const w = await pickClosedWindow(spawnedBaseUrl, spawnedToken, 3);
  if (!w) { console.warn('skip multi: corpus has <3 usable 1m symbols'); return; }
  const app = await buildApp(realCfg(spawnedBaseUrl, spawnedToken));
  try {
    const a = await runToTerminal(app, { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to });
    const b = await runToTerminal(app, { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to });
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('completed');
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint);
    expect(a.resultHash).toBe(b.resultHash);
  } finally { await app.close?.(); }
});

it('real platform: single-symbol run is deterministic across two identical closed-window runs', async () => {
  const w = await pickClosedWindow(spawnedBaseUrl, spawnedToken, 1);
  if (!w) { console.warn('skip single: corpus has no usable 1m symbol'); return; }
  const app = await buildApp(realCfg(spawnedBaseUrl, spawnedToken));
  try {
    const a = await runToTerminal(app, { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to });
    const b = await runToTerminal(app, { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to });
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint);
  } finally { await app.close?.(); }
});
```

> NOTE: `spawnedBaseUrl`/`spawnedToken`/`runToTerminal` come from the existing test's harness — reuse them (the existing test already spawns the platform binary and submits a run; today it wires `dataSource:'mock'`). Switch/duplicate that wiring to `dataSource:'real'`. Ensure the spawned server accepts `spawnedToken` (loopback-trusted ⇒ any token; token-auth ⇒ set `HISTORICAL_HTTP_TOKENS` to the sha256 of `spawnedToken`). The window and symbols are DERIVED from the spawned server's `/historical/coverage` via `pickClosedWindow` (with a `MARGIN_MS` trim below max `toMs` for a closed window) — never hardcoded; if the corpus is too small the case skips (logged), so the gate is self-configuring rather than environment-specific.

- [ ] **Step 2: Run to verify it fails (or is skipped without the flag)**

Run: `RUN_CROSS_REPO_E2E=true pnpm test cross-repo-historical-e2e`
Expected: without the `'real'` factory/error changes this would fail; after Tasks 1–4 it should pass. If the sibling `trading-platform` checkout is absent, the test self-skips — note that in the run output and rely on the unit tests + a manual VPS run for coverage.

- [ ] **Step 3: (no new production code)** — this task only extends the gate. If an assertion needs a run-summary field not currently returned by the poll helper, thread it through the helper (not the engine).

- [ ] **Step 4: Verify**

Run: `RUN_CROSS_REPO_E2E=true pnpm test cross-repo-historical-e2e`
Expected: PASS (both new cases) when the sibling checkout is present.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/cross-repo-historical-e2e.integration.test.ts
git commit -m "test(e2e): real-platform gate — single+multi-symbol closed-window determinism"
```

---

### Task 6: Docs — real as production posture (not code default)

**Files:**
- Modify: `apps/backtester/docs/OPERATIONS.md` (or repo `docs/OPERATIONS.md` — locate first)
- Modify: `deploy/vps/backtester.env.example`

**Interfaces:** none (documentation).

- [ ] **Step 1: Document the real data source in OPERATIONS.md**

Add a "Real platform data source" subsection: the env matrix (`BACKTESTER_DATA_SOURCE=real` + `BACKTESTER_REAL_PLATFORM_URL` + `BACKTESTER_REAL_PLATFORM_TOKEN`), the fail-fast behaviour (missing/whitespace ⇒ startup error), and an explicit sentence: **`'real'` is the recommended production posture but NOT the code default — the code default stays `fixture`.** Note the failure taxonomy: real-fetch failures terminate `missing_dataset` with `errorDetail = cause=<cause>; datasetRef=<ref>` (list the finite cause set).

- [ ] **Step 2: Document the env in the VPS example**

In `deploy/vps/backtester.env.example`, add (commented) the real pair with a note:

```bash
# --- Real platform historical data (production posture; NOT the code default) ---
# Set DATA_SOURCE=real to read from the live trading-platform historical API.
# Both URL and TOKEN are required when real is selected (fail-fast at startup).
# BACKTESTER_DATA_SOURCE=real
# BACKTESTER_REAL_PLATFORM_URL=http://127.0.0.1:8088
# BACKTESTER_REAL_PLATFORM_TOKEN=<raw bearer whose sha256 is in the platform HISTORICAL_HTTP_TOKENS>
```

- [ ] **Step 3: Verify docs render / no broken refs**

Run: `pnpm check` (full gate — typecheck + tests + lint) to confirm nothing regressed.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backtester/docs/OPERATIONS.md deploy/vps/backtester.env.example
git commit -m "docs(ops): real platform data source — production posture, env matrix, failure causes"
```

---

## Self-Review

**Spec coverage:**
- Distinct `'real'` config pair → Task 1. Fail-fast validation invariant → Task 1. Factory branch → Task 2. Normalized finite cause + fixed `errorDetail` string → Task 3 (cause) + Task 4 (worker detail). `missing_dataset` preserved → Task 4. E2E gate single+multi closed-window determinism on fingerprint/hash → Task 5. Docs (production posture ≠ code default) → Task 6. Testing groups: config validation (Task 1), factory selection (Task 2), cause mapping (Task 3/4), opt-in live E2E (Task 5). All spec sections mapped.

**Placeholder scan:** the E2E and worker tasks reference existing test harnesses (`cross-repo-historical-e2e`, `worker-error-visibility`) rather than reproducing their spawn/submit scaffolding — flagged with explicit NOTEs and fixed assertion intent; every production code step shows the actual code.

**Type consistency:** `RealDataCause` / `RealDataUnavailableError` (field `reason`, message `cause=<reason>; datasetRef=<ref>`) used identically in Tasks 3 and 4; `realPlatformUrl`/`realPlatformToken` consistent across Tasks 1–2; terminal code `missing_dataset` consistent Tasks 3-note/4.

## Done when

All 6 tasks committed; `pnpm check` green; the opt-in real-platform E2E passes when the sibling `trading-platform` checkout is present; roadmap Phase A #1/#2 closable.
