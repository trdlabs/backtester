# Strategy-Route + Equivalence + Sign-Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать движку app-pipeline исполнять бандл `kind:'strategy'` (lifecycle `onBarClose`/`onPositionBar`), доказать byte/economics-эквивалентность доставки стратегии (trusted ↔ bundle) и произвести подписанный `backtest-evidence/v1`.

**Architecture:** Engine/registry/sandbox уже умеют исполнять strategy-бандл (канал `strategyBundles` в `createModuleRegistry` ставит `provenance:'bundle'` → `route.forStrategy` → `SandboxModuleExecutor.executeStrategyHook` → `runSymbol` lifecycle). Не хватает проводки: аддитивный `engine:'strategy'` селектор, проброс `strategyBundles` через `buildInlineOverlayRegistry`, wrapper `runStrategyBacktest`, ветка в `processNextQueued`. Поверх — чистый компаратор `compareBacktestRuns` и sign-flow `produceStrategyEvidence` с abort-before-sign gate.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, Node `crypto` (Ed25519), pnpm-monorepo. Гейт — `pnpm check`.

## Global Constraints

- **Кросс-граничный контракт НЕ менять (Вариант 2):** flat self-contained ESM `export default createStrategyModule`; `bundleHash = computeBundleHash(rawBytes) = sha256(сырых байтов)`; формат `'sha256:'+hex` (`/^sha256:[0-9a-f]{64}$/`).
- **Формат evidence НЕ менять:** `backtest-evidence/v1`, `SignedEvidenceBody`, canonical mirror `src/evidence/canonical.ts` (sorted-key stableStringify, БЕЗ trailing newline, БЕЗ quantization — НЕ `determinism/canonical-json.ts`), Ed25519 detached base64. Верифицируется платформой офлайн.
- **Byte-parity НЕ ломать:** momentum-путь (golden `eff10116…`) и overlay-роутинг (platform-derived goldens `baseline.hash`/`variant.hash`, golden `0be9931c`) остаются зелёными. Все новые каналы — аддитивные, с дефолт-пустыми значениями.
- **`engine` — НЕ 017-поле:** `runStrategyBacktest`/`runOverlayBacktest` ОБЯЗАНЫ снять `engine` ДО вызова engine `runBacktest` (он не должен попасть в hashed `RunOutcome`).
- **NEVER sign `verdict:'passed'`** иначе как из реальных метрик прогона через `decideVerdict`.
- **Тесты:** descriptive kebab-case (`<topic>.test.ts`); Docker/sandbox-зависимые — `<topic>.integration.test.ts` (скипаются в WSL2, гейтятся в CI).
- **Регресс:** `pnpm check` (== `pnpm typecheck && pnpm test`) EXIT=0 перед PR. Одиночный тест при разработке: `pnpm exec vitest run apps/backtester/test/<name>.test.ts`.

---

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `packages/sdk/src/contracts/module.ts` | enum `BacktestEngine` | Modify (+`'strategy'`) |
| `packages/sdk/src/builder/preflight.ts` | `engineMatchesKind` | Modify |
| `apps/backtester/src/engine/trusted-registry.ts` | `buildInlineOverlayRegistry` | Modify (+`strategyBundles`) |
| `apps/backtester/src/engine/run-strategy.ts` | `runStrategyBacktest` wrapper | Create |
| `apps/backtester/src/jobs/worker.ts` | `processNextQueued` strategy-ветка | Modify |
| `apps/backtester/src/engine/equivalence.ts` | `compareBacktestRuns` (чистый) | Create |
| `apps/backtester/src/evidence/produce-strategy-evidence.ts` | sign-flow (gate→equiv→verdict→sign) | Create |
| `apps/backtester/test/strategy-registry.test.ts` | provenance:'bundle' через builder | Create |
| `apps/backtester/test/equivalence.test.ts` | `compareBacktestRuns` юнит | Create |
| `apps/backtester/test/strategy-route.integration.test.ts` | worker→sandbox→lifecycle + twin-equivalence (Docker) | Create |
| `apps/backtester/test/produce-strategy-evidence.test.ts` | gate/verdict/sign юнит (инъекция outcomes) | Create |

---

## Task 1: `engine:'strategy'` в контракте + preflight

**Files:**
- Modify: `packages/sdk/src/contracts/module.ts:16`
- Modify: `packages/sdk/src/builder/preflight.ts:35`
- Test: `packages/sdk/test/preflight.test.ts` (если есть; иначе добавить describe в существующий preflight-тест — найти через `search_symbols engineMatchesKind preflight test`)

**Interfaces:**
- Produces: `type BacktestEngine = 'momentum' | 'overlay' | 'strategy'`; `engineMatchesKind('strategy', 'strategy') === true`.

- [ ] **Step 1: Написать падающий тест**

Найти существующий preflight-тест (`search_symbols engineMatchesKind`); если `engineMatchesKind` приватная — тестировать через публичную `preflight(...)`-функцию, которая её зовёт. Добавить:

```ts
it('engine "strategy" принимает только kind:"strategy"', () => {
  // через публичный preflight: strategy-бандл + engine:'strategy' → ok; + engine:'overlay' → mismatch.
  // Если engineMatchesKind экспортируема для теста — прямой ассерт:
  expect(engineMatchesKind('strategy', 'strategy')).toBe(true);
  expect(engineMatchesKind('strategy', 'overlay')).toBe(false);
});
```

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run packages/sdk/test/preflight.test.ts`
Expected: FAIL (`'strategy'` не назначаемо типу `BacktestEngine` — tsc/тест).

- [ ] **Step 3: Реализация**

В `module.ts:16`:
```ts
export type BacktestEngine = 'momentum' | 'overlay' | 'strategy';
```
В `preflight.ts` `engineMatchesKind`:
```ts
function engineMatchesKind(engine: BacktestEngine, kind: ModuleKind): boolean {
  if (engine === 'overlay') return kind === 'overlay';
  if (engine === 'strategy') return kind === 'strategy';
  // 'momentum' engine consumes strategy modules.
  return kind === 'strategy';
}
```

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run packages/sdk/test/preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/sdk/src/contracts/module.ts packages/sdk/src/builder/preflight.ts packages/sdk/test/preflight.test.ts
git commit -m "feat(contract): additive engine:'strategy' selector + preflight kind match"
```

---

## Task 2: `strategyBundles` через `buildInlineOverlayRegistry`

**Files:**
- Modify: `apps/backtester/src/engine/trusted-registry.ts:22`
- Test: `apps/backtester/test/strategy-registry.test.ts` (Create)

**Interfaces:**
- Consumes: `createModuleRegistry({ strategies, strategyBundles?, overlays, overlayBundles?, riskProfiles, executionProfiles })` (УЖЕ существует, routing.ts:105 — `strategyBundles` ставит `provenance:'bundle'`+`bundle`).
- Produces: `buildInlineOverlayRegistry(overlayBundles: readonly ModuleBundle[], strategyBundles?: readonly ModuleBundle[]): ModuleRegistry019`. Overlay-путь байт-идентичен (вызов с одним аргументом → `strategyBundles=[]`).

- [ ] **Step 1: Написать падающий тест** (`apps/backtester/test/strategy-registry.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInlineOverlayRegistry } from '../src/engine/trusted-registry.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import type { ModuleBundle } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, 'fixtures/overlay/bundles/short-after-pump.bundle.json');

describe('strategy-bundle registration (019 registry)', () => {
  it('сабмиченный strategy-бандл резолвится как baseline с provenance:"bundle"', async () => {
    const inline = JSON.parse(readFileSync(BUNDLE, 'utf8'));
    const mat = await materializeBundle(inline);
    try {
      // собрать ModuleBundle из материализованной директории так же, как sandboxBundleFor в worker —
      // см. test/overlay-sandbox-materialize.test.ts для точного assemble-паттерна
      const bundle: ModuleBundle = mat.bundle; // assemble per existing helper
      const registry = buildInlineOverlayRegistry([], [bundle]);
      const resolved = registry.resolveStrategy({ id: 'short_after_pump', version: '0.1.0' });
      expect(resolved).toBeDefined();
      expect(resolved!.provenance).toBe('bundle');
      // overlay-путь не затронут:
      expect(buildInlineOverlayRegistry([]).resolveStrategy({ id: 'short_after_pump', version: '0.1.0' })?.provenance).toBe('trusted');
    } finally {
      await mat.cleanup();
    }
  });
});
```
> Примечание: точный assemble материализованного `ModuleBundle` (с `descriptor`/`bundleDir`) скопировать из `test/overlay-sandbox-materialize.test.ts` (прочитать через gortex `get_symbol_source`/`read_file`). `short_after_pump@0.1.0` — манифест фикстуры.

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run apps/backtester/test/strategy-registry.test.ts`
Expected: FAIL (`buildInlineOverlayRegistry` принимает один аргумент; strategy-бандл не регистрируется → `resolved` undefined).

- [ ] **Step 3: Реализация** (`trusted-registry.ts:22`)

```ts
export function buildInlineOverlayRegistry(
  overlayBundles: readonly ModuleBundle[],
  strategyBundles: readonly ModuleBundle[] = [],
): ModuleRegistry019 {
  return createModuleRegistry({
    strategies: [...TRUSTED_REGISTRY_DEFINITION.strategies],
    strategyBundles: [...strategyBundles],
    overlays: [...TRUSTED_REGISTRY_DEFINITION.overlays],
    overlayBundles: [...overlayBundles],
    riskProfiles: [...TRUSTED_REGISTRY_DEFINITION.riskProfiles],
    executionProfiles: [...TRUSTED_REGISTRY_DEFINITION.executionProfiles],
  });
}
```

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run apps/backtester/test/strategy-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/src/engine/trusted-registry.ts apps/backtester/test/strategy-registry.test.ts
git commit -m "feat(engine): wire strategyBundles through buildInlineOverlayRegistry (provenance:bundle baseline)"
```

---

## Task 3: `runStrategyBacktest` wrapper

**Files:**
- Create: `apps/backtester/src/engine/run-strategy.ts`
- Test: покрывается Task 6 integration (sandbox). Здесь — тип/контракт-тест без Docker.

**Interfaces:**
- Consumes: `runBacktest(engineRequest, { registry, marketTape?, router? })` (engine/runner.ts); `BacktestRunRequest`, `RunOutcome`, `OverlayRunDeps`-аналог.
- Produces: `runStrategyBacktest(request: BacktestRunRequest, deps: StrategyRunDeps): Promise<RunOutcome>`, где `StrategyRunDeps = { registry: TrustedModuleRegistry; marketTape?: MarketTapeDataset; router?: ExecutorRouter }`. Снимает `engine` ДО `runBacktest`; НЕ передаёт overlayRefs (baseline-only прогон).

- [ ] **Step 1: Написать падающий тест** (добавить в `apps/backtester/test/strategy-registry.test.ts`)

```ts
import { runStrategyBacktest } from '../src/engine/run-strategy.js';

it('runStrategyBacktest снимает engine-поле и не падает на baseline-only прогоне (trusted)', async () => {
  // дешёвый контракт-тест: trusted shortAfterPump как baseline, engine:'strategy', без бандла → in-process.
  // (полный sandbox-прогон — в integration-тесте Task 6.)
  const req = { /* загрузить fixtures/overlay/requests/baseline.json */ } as any;
  const reqStrategy = { ...req, engine: 'strategy' as const };
  const registry = buildInlineOverlayRegistry([]); // trusted shortAfterPump
  // marketTape собрать как в overlay-golden.test.ts::overlayDeps
  const out = await runStrategyBacktest(reqStrategy, { registry, marketTape });
  expect(out.status).toBe('completed');
});
```

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run apps/backtester/test/strategy-registry.test.ts`
Expected: FAIL (`run-strategy.js` не существует).

- [ ] **Step 3: Реализация** (`run-strategy.ts` — зеркало `run-overlay.ts`)

```ts
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { RunOutcome } from './artifacts.js';
import type { TrustedModuleRegistry } from './registry.js';
import type { MarketTapeDataset } from './data-adapter.js';
import type { ExecutorRouter } from './sandbox/routing.js';
import { runBacktest } from './runner.js';

export interface StrategyRunDeps {
  readonly registry: TrustedModuleRegistry;
  readonly marketTape?: MarketTapeDataset;
  readonly router?: ExecutorRouter;
}

/**
 * Strategy-bundle run. Baseline = сабмиченный kind:'strategy' бандл (provenance:'bundle' → sandbox),
 * БЕЗ overlays. Снимает backtester-only `engine` ДО lifted runner — `engine` не 017-поле и не должен
 * попасть в hashed RunOutcome (platform parity).
 */
export async function runStrategyBacktest(
  request: BacktestRunRequest,
  deps: StrategyRunDeps,
): Promise<RunOutcome> {
  const { engine: _engine, overlayRefs: _overlayRefs, ...engineRequest } = request;
  return await runBacktest(engineRequest, {
    registry: deps.registry,
    marketTape: deps.marketTape,
    ...(deps.router ? { router: deps.router } : {}),
  });
}
```
> Сверить точные имена/пути импортов `TrustedModuleRegistry`, `MarketTapeDataset`, `ExecutorRouter` с `run-overlay.ts` (тот же набор) через gortex перед записью.

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run apps/backtester/test/strategy-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/src/engine/run-strategy.ts apps/backtester/test/strategy-registry.test.ts
git commit -m "feat(engine): runStrategyBacktest wrapper (baseline-only lifecycle, strips engine field)"
```

---

## Task 4: `processNextQueued` strategy-ветка (app-pipeline dispatch)

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts:131` (добавить ветку перед `else` momentum)
- Test: поведение через Task 6 integration (Docker). Дешёвый юнит — «strategy без бандла → reject».

**Interfaces:**
- Consumes: `buildInlineOverlayRegistry([], [bundle])` (Task 2), `runStrategyBacktest` (Task 3), `sandboxBundleFor`, `overlayRouterFor`, `overlayTapeCache`, `persistOverlayArtifacts`, `toOverlaySummary` (существуют, используются overlay-веткой).
- Produces: для `request.engine === 'strategy'` — RunOutcome через sandbox-routed baseline; summary/persist как overlay.

- [ ] **Step 1: Написать падающий тест** (новый describe в существующем worker-тесте — найти через `search_symbols processNextQueued test` / `find_files worker test`)

```ts
it('strategy-engine job без бандла отклоняется (нужны ESM-байты)', async () => {
  // enqueue job: request.engine='strategy', bundleHash undefined.
  // processNextQueued → terminal failed, terminalCode 'validation_error' (или 'missing_dataset'-аналог).
  // следовать существующему worker-test харнессу (in-memory store).
  const row = await processNextQueued(deps);
  expect(row?.status).toBe('failed');
});
```

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run apps/backtester/test/<worker-test>.test.ts`
Expected: FAIL (нет strategy-ветки → падает в momentum-путь с другим кодом/поведением).

- [ ] **Step 3: Реализация** — вставить ветку в `processNextQueued` МЕЖДУ overlay-веткой и `else` (momentum):

```ts
} else if (claimed.request.engine === 'strategy') {
  // ===== STRATEGY PATH — kind:'strategy' lifecycle-бандл через sandbox (закрывает gap PR #57) =====
  if (claimed.bundleHash === undefined || sandboxBundle === undefined) {
    throw new RunnerError('validation_error', 'strategy run requires a submitted bundle (ESM bytes)');
  }
  if (sandboxBundle.bundle.manifest.kind !== 'strategy') {
    throw new RunnerError('validation_error', `strategy engine requires manifest.kind="strategy", got "${sandboxBundle.bundle.manifest.kind}"`);
  }
  const r = claimed.request;
  const marketTape = await overlayTapeCache.getOrBuild(
    tapeCacheKey({ datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, from: r.period.from, to: r.period.to }),
    () => buildOverlayDataset(deps.dataPort, { datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, period: r.period }),
  );
  dsFingerprint = contentRef(r.symbols.map((s) => marketTape.candles(s)));
  const engineRequest: BacktestRunRequest = {
    runId,
    mode: r.mode,
    moduleRef: r.moduleRef,           // указывает на манифест бандла (baseline)
    datasetRef: r.datasetRef,
    symbols: r.symbols,
    timeframe: r.timeframe,
    period: r.period,
    ...(r.params !== undefined ? { params: r.params } : {}),
    ...(r.riskProfileRef !== undefined ? { riskProfileRef: r.riskProfileRef } : {}),
    ...(r.executionProfileRef !== undefined ? { executionProfileRef: r.executionProfileRef } : {}),
    seed: claimed.effectiveSeed,
    metrics: r.metrics,
    ...(r.robustnessChecks !== undefined ? { robustnessChecks: r.robustnessChecks } : {}),
  };
  const registry = buildInlineOverlayRegistry([], [sandboxBundle.bundle]);
  sandboxRouter = overlayRouterFor(deps);
  const outcome = await runStrategyBacktest(engineRequest, {
    registry, marketTape, ...(sandboxRouter ? { router: sandboxRouter } : {}),
  });
  if (outcome.status !== 'completed') {
    throw new RunnerError('validation_error', `strategy run rejected: ${JSON.stringify(outcome.validation.issues)}`);
  }
  resultHash = contentRef(outcome);
  const persisted = await persistOverlayArtifacts(deps.artifactStore, outcome, dsFingerprint);
  manifest = persisted.manifest;
  summary = toOverlaySummary(outcome, runId, persisted.artifactRefs, resultHash, dsFingerprint, claimed.bundleHash);
} else {
```
> Импорты `runStrategyBacktest` (Task 3) добавить в шапку worker.ts рядом с `runOverlayBacktest`. Сверить точные имена `overlayRouterFor`/`overlayTapeCache`/`tapeCacheKey`/`buildOverlayDataset`/`persistOverlayArtifacts`/`toOverlaySummary` (уже импортированы для overlay-ветки).

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run apps/backtester/test/<worker-test>.test.ts`
Expected: PASS. Также `pnpm exec vitest run apps/backtester/test/overlay-golden.test.ts apps/backtester/test/momentum-guardrail.test.ts` — overlay/momentum НЕ затронуты.

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/<worker-test>.test.ts
git commit -m "feat(engine): route engine:'strategy' jobs through app-pipeline (sandbox lifecycle baseline)"
```

---

## Task 5: `compareBacktestRuns` (чистый equivalence-харнесс)

**Files:**
- Create: `apps/backtester/src/engine/equivalence.ts`
- Test: `apps/backtester/test/equivalence.test.ts` (Create)

**Interfaces:**
- Consumes: `RunOutcome` (artifacts.ts), `Trade` (artifacts.ts), `contentRef` (determinism/hash.js).
- Produces:
  ```ts
  interface TradeDivergence { readonly index: number; readonly field: string; readonly expected: unknown; readonly actual: unknown; }
  interface EquivalenceResult {
    readonly equivalent: boolean;
    readonly resultHashMatch: boolean;
    readonly firstDivergence?: TradeDivergence;
    readonly curatedTradeCount: number;
    readonly candidateTradeCount: number;
  }
  function compareBacktestRuns(curated: RunOutcome, candidate: RunOutcome): EquivalenceResult;
  ```

- [ ] **Step 1: Написать падающий тест** (`apps/backtester/test/equivalence.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { compareBacktestRuns } from '../src/engine/equivalence.js';
import type { RunOutcome, Trade } from '../src/engine/artifacts.js';

function trade(over: Partial<Trade>): Trade {
  return { entryTs: 1, exitTs: 2, side: 'long', entryPrice: 100, exitPrice: 110, pnlPct: 10, ...over } as Trade;
}
function completed(trades: Trade[]): RunOutcome {
  return { status: 'completed', baseline: { trades, evidence: { equityCurve: [] } } as any, variant: null, comparison: null };
}

describe('compareBacktestRuns', () => {
  it('идентичные прогоны эквивалентны', () => {
    const a = completed([trade({})]);
    const r = compareBacktestRuns(a, completed([trade({})]));
    expect(r.equivalent).toBe(true);
    expect(r.resultHashMatch).toBe(true);
  });

  it('расхождение в pnlPct → первый расходящийся бар + diff', () => {
    const curated = completed([trade({}), trade({ entryTs: 3, exitTs: 4, pnlPct: 5 })]);
    const candidate = completed([trade({}), trade({ entryTs: 3, exitTs: 4, pnlPct: 7 })]);
    const r = compareBacktestRuns(curated, candidate);
    expect(r.equivalent).toBe(false);
    expect(r.firstDivergence).toEqual({ index: 1, field: 'pnlPct', expected: 5, actual: 7 });
  });

  it('разное число сделок → не эквивалентны', () => {
    const r = compareBacktestRuns(completed([trade({})]), completed([]));
    expect(r.equivalent).toBe(false);
    expect(r.candidateTradeCount).toBe(0);
  });

  it('rejected-прогон → не эквивалентен', () => {
    const rej = { status: 'rejected', validation: { issues: [] } } as RunOutcome;
    expect(compareBacktestRuns(rej, completed([])).equivalent).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run apps/backtester/test/equivalence.test.ts`
Expected: FAIL (`equivalence.js` не существует).

- [ ] **Step 3: Реализация** (`equivalence.ts`)

```ts
import type { RunOutcome, Trade } from './artifacts.js';
import { contentRef } from '../determinism/hash.js';

export interface TradeDivergence {
  readonly index: number;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}
export interface EquivalenceResult {
  readonly equivalent: boolean;
  readonly resultHashMatch: boolean;
  readonly firstDivergence?: TradeDivergence;
  readonly curatedTradeCount: number;
  readonly candidateTradeCount: number;
}

// Поля сделки, сверяемые побарно (economics-паритет). Порядок = порядок проверки.
const TRADE_FIELDS: readonly (keyof Trade)[] = ['entryTs', 'exitTs', 'side', 'entryPrice', 'exitPrice', 'pnlPct'];

function firstTradeDivergence(a: readonly Trade[], b: readonly Trade[]): TradeDivergence | undefined {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    for (const f of TRADE_FIELDS) {
      if (a[i]![f] !== b[i]![f]) {
        return { index: i, field: String(f), expected: a[i]![f], actual: b[i]![f] };
      }
    }
  }
  if (a.length !== b.length) {
    const idx = n;
    return { index: idx, field: 'count', expected: a.length, actual: b.length };
  }
  return undefined;
}

/**
 * Byte/economics-паритет двух backtest-прогонов (curated trusted ↔ kind:'strategy' bundle).
 * Слой 1 — result_hash (contentRef). Слой 2 — побарный diff сделок → первый расходящийся бар.
 * Расхождение → equivalent:false + firstDivergence{index,field,expected,actual}.
 */
export function compareBacktestRuns(curated: RunOutcome, candidate: RunOutcome): EquivalenceResult {
  if (curated.status !== 'completed' || candidate.status !== 'completed') {
    return {
      equivalent: false, resultHashMatch: false,
      curatedTradeCount: curated.status === 'completed' ? curated.baseline.trades.length : 0,
      candidateTradeCount: candidate.status === 'completed' ? candidate.baseline.trades.length : 0,
    };
  }
  const resultHashMatch = contentRef(curated) === contentRef(candidate);
  const div = firstTradeDivergence(curated.baseline.trades, candidate.baseline.trades);
  return {
    equivalent: resultHashMatch && div === undefined,
    resultHashMatch,
    ...(div ? { firstDivergence: div } : {}),
    curatedTradeCount: curated.baseline.trades.length,
    candidateTradeCount: candidate.baseline.trades.length,
  };
}
```
> Сверить точную форму `Trade` (поля `entryTs/exitTs/side/...`) через gortex `get_symbol_source ...artifacts.ts::Trade` и подправить `TRADE_FIELDS`/тестовую фабрику под реальные имена ПЕРЕД записью теста.

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run apps/backtester/test/equivalence.test.ts`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/src/engine/equivalence.ts apps/backtester/test/equivalence.test.ts
git commit -m "feat(engine): compareBacktestRuns — byte/economics parity + first-divergence diff"
```

---

## Task 6: Integration — worker→sandbox→lifecycle + twin-equivalence (Docker)

**Files:**
- Create: `apps/backtester/test/strategy-route.integration.test.ts`

**Interfaces:**
- Consumes: `runOverlayBacktest` (curated trusted), `runStrategyBacktest` (Task 3, candidate sandbox), `buildInlineOverlayRegistry` (Task 2), `compareBacktestRuns` (Task 5), `materializeBundle` + sandbox-router assemble (паттерн из `test/overlay-sandbox-materialize.test.ts`), `contentRef`.

- [ ] **Step 1: Написать тест** (skip-в-WSL2 как существующие integration-тесты — скопировать гард Docker-доступности из `test/*.integration.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { buildTrustedRegistry, buildInlineOverlayRegistry } from '../src/engine/trusted-registry.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { compareBacktestRuns } from '../src/engine/equivalence.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { contentRef } from '../src/determinism/hash.js';
import { FIXTURES_DIR } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadReq = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(HERE, 'fixtures/overlay/requests', n), 'utf8'));

// гард Docker (скопировать из существующего *.integration.test.ts)
const describeIfDocker = process.env.BT_SANDBOX_DOCKER ? describe : describe.skip;

describeIfDocker('strategy-route equivalence — short_after_pump twin (delivery equivalence)', () => {
  it('backtest(kind:"strategy" bundle через новый route) == backtest(trusted baseline)', async () => {
    const baseReq = loadReq('baseline.json'); // moduleRef = short_after_pump@0.1.0
    const dataPort = new FixtureDataPort(FIXTURES_DIR);
    const marketTape = await buildOverlayDataset(dataPort, {
      datasetRef: baseReq.datasetRef, symbols: baseReq.symbols, timeframe: baseReq.timeframe, period: baseReq.period,
    });

    // CURATED: trusted shortAfterPump через engine-runner lifecycle (in-process)
    const curated = await runOverlayBacktest(baseReq, { registry: buildTrustedRegistry(), marketTape });

    // CANDIDATE: short_after_pump kind:'strategy' bundle через НОВЫЙ strategy-route (sandbox)
    const inline = JSON.parse(readFileSync(resolve(HERE, 'fixtures/overlay/bundles/short-after-pump.bundle.json'), 'utf8'));
    const mat = await materializeBundle(inline);
    try {
      const bundle = mat.bundle; // assemble per overlay-sandbox-materialize.test.ts
      const sandboxRouter = /* createExecutorRouter(...) как в overlay-sandbox тесте */ undefined as any;
      const registry = buildInlineOverlayRegistry([], [bundle]);
      const candidate = await runStrategyBacktest(
        { ...baseReq, engine: 'strategy' },
        { registry, marketTape, router: sandboxRouter },
      );
      const eq = compareBacktestRuns(curated, candidate);
      expect(eq.firstDivergence).toBeUndefined();
      expect(eq.equivalent).toBe(true);
      expect(contentRef(candidate)).toBe(contentRef(curated));
    } finally {
      await mat.cleanup();
    }
  });
});
```
> Точный assemble `ModuleBundle` из `mat` + конструкция sandbox-router (`createExecutorRouter`/`overlayRouterFor`) — скопировать из `test/overlay-sandbox-materialize.test.ts` (прочитать через gortex). Имя env-гарда Docker — взять из существующего integration-теста.

- [ ] **Step 2: Запустить локально (WSL2)**

Run: `pnpm exec vitest run apps/backtester/test/strategy-route.integration.test.ts`
Expected: SKIPPED в WSL2 (нет Docker) — как существующие integration-тесты. Тест-файл компилируется (tsc).

- [ ] **Step 3: Проверить компиляцию + что curated-половина зелёная**

Run: `pnpm typecheck && pnpm exec vitest run apps/backtester/test/overlay-golden.test.ts`
Expected: PASS (типы сходятся; curated-путь не сломан).

- [ ] **Step 4: Коммит**

```bash
git add apps/backtester/test/strategy-route.integration.test.ts
git commit -m "test(engine): integration twin-equivalence — kind:'strategy' bundle route == trusted baseline (Docker)"
```

---

## Task 7: `produceStrategyEvidence` — gate → equivalence → verdict → sign

**Files:**
- Create: `apps/backtester/src/evidence/produce-strategy-evidence.ts`
- Test: `apps/backtester/test/produce-strategy-evidence.test.ts` (Create)

**Interfaces:**
- Consumes: `compareBacktestRuns` (Task 5), `validateBundle(bundle, ctx): BundleValidationResult` (`src/engine/sandbox/acceptance-gate.js`), `platformContractContext` (`@trading/research-contracts/research`), `computeMetrics` (engine/metrics.js), `decideVerdict` (evidence/verdict.js), `sha256BundleRef`/`serializeArtifact`/`artifactRef` (evidence/artifact.js), `buildEvidenceBody`/`EvidenceScope` (evidence/body.js), `signEvidence`/`SigningKey` (evidence/signing.js).
- Produces:
  ```ts
  interface StrategyEvidenceInput {
    readonly bundle: ModuleBundle;            // материализованный (bundleDir+descriptor) — для gate
    readonly bundleBytes: Buffer;             // сырые байты ESM-бандла — для sha256BundleRef
    readonly curated: RunOutcome;             // trusted baseline прогон
    readonly candidate: RunOutcome;           // bundle-route (sandbox) прогон
    readonly scope: EvidenceScope;
    readonly key: SigningKey;
    readonly backtesterRunId: string;
  }
  function produceStrategyEvidence(input: StrategyEvidenceInput): ProduceStrategyResult;
  // ProduceStrategyResult { artifact, artifactRef, bundleHash, keyId, verdict, equivalence }
  ```
- Порядок (abort-before-sign): (1) gate `validateBundle` → rejected ⇒ throw; (2) `compareBacktestRuns` → !equivalent ⇒ throw с баром+diff; (3) metrics→verdict → !=='passed' ⇒ throw; (4) подписать.

- [ ] **Step 1: Написать падающий тест** (`apps/backtester/test/produce-strategy-evidence.test.ts`) — инъекция outcomes, без Docker

```ts
import { describe, expect, it } from 'vitest';
import { produceStrategyEvidence } from '../src/evidence/produce-strategy-evidence.js';
import { generateSigningKey, verifySignedEvidenceLocal } from '../src/evidence/signing.js';
import type { RunOutcome, Trade } from '../src/engine/artifacts.js';

// фабрики идентичных прогонов с метриками, дающими verdict 'passed' (≥1 winning trade)
function out(trades: Trade[]): RunOutcome { /* как в equivalence.test.ts + evidence.equityCurve с ростом */ }
const scope = { datasetRef: 'short_after_pump-overlay', window: { fromMs: 0, toMs: 60000 }, symbols: ['BTCUSDT'], timeframe: '1m' };

describe('produceStrategyEvidence (abort-before-sign)', () => {
  it('эквивалентность + accepted bundle + passed → подписанный артефакт верифицируется', () => {
    const key = generateSigningKey();
    const eq = out([/* winning trade */]);
    const r = produceStrategyEvidence({ bundle: acceptedBundleStub, bundleBytes: Buffer.from('esm'), curated: eq, candidate: eq, scope, key, backtesterRunId: 'bt-x' });
    expect(r.verdict).toBe('passed');
    expect(verifySignedEvidenceLocal(r.artifact, { [key.keyId]: key.publicKeyPem })).toBe(true);
    expect(r.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('расхождение прогонов → throw, артефакт НЕ выпущен', () => {
    const key = generateSigningKey();
    expect(() => produceStrategyEvidence({
      bundle: acceptedBundleStub, bundleBytes: Buffer.from('esm'),
      curated: out([tradeA]), candidate: out([tradeB_divergent]), scope, key, backtesterRunId: 'bt-x',
    })).toThrow(/divergen|расхожд|bar/i);
  });

  it('rejected bundle → throw ДО подписи', () => {
    const key = generateSigningKey();
    expect(() => produceStrategyEvidence({
      bundle: rejectedBundleStub, bundleBytes: Buffer.from('esm'), curated: eqOut, candidate: eqOut, scope, key, backtesterRunId: 'bt-x',
    })).toThrow(/validation rejected/i);
  });
});
```
> `acceptedBundleStub`/`rejectedBundleStub` — материализовать `short-after-pump.bundle.json` (accepted) и битый бандл (rejected, напр. mismatched bundleHash). Если материализация требует Docker/fs — этот тест держать lightweight: замокать `validateBundle` через инъекцию (см. Step 3 — функция принимает результат gate? НЕТ: gate внутри). Альтернатива: вынести gate-вызов так, чтобы тест подавал реальный материализованный бандл (fs, без Docker — materializeBundle не требует Docker). Предпочесть реальный материализованный бандл.

- [ ] **Step 2: Запустить — упадёт**

Run: `pnpm exec vitest run apps/backtester/test/produce-strategy-evidence.test.ts`
Expected: FAIL (`produce-strategy-evidence.js` не существует).

- [ ] **Step 3: Реализация** (`produce-strategy-evidence.ts`)

```ts
import type { ModuleBundle } from '@trading/research-contracts';
import { platformContractContext } from '@trading/research-contracts/research';
import type { RunOutcome } from '../engine/artifacts.js';
import { compareBacktestRuns } from '../engine/equivalence.js';
import { validateBundle } from '../engine/sandbox/acceptance-gate.js';
import { computeMetrics } from '../engine/metrics.js';
import { decideVerdict } from './verdict.js';
import { buildEvidenceBody, type EvidenceScope, type SignedBacktestEvidence } from './body.js';
import { signEvidence, type SigningKey } from './signing.js';
import { serializeArtifact, artifactRef, sha256BundleRef } from './artifact.js';

export interface StrategyEvidenceInput {
  readonly bundle: ModuleBundle;
  readonly bundleBytes: Buffer;
  readonly curated: RunOutcome;
  readonly candidate: RunOutcome;
  readonly scope: EvidenceScope;
  readonly key: SigningKey;
  readonly backtesterRunId: string;
}
export interface ProduceStrategyResult {
  readonly artifact: SignedBacktestEvidence;
  readonly artifactRef: string;
  readonly bundleHash: string;
  readonly keyId: string;
  readonly verdict: 'passed' | 'failed';
}

/**
 * Полный lifecycle proof: abort-before-sign gate → twin-equivalence → verdict → sign.
 * Подписывает ТОЛЬКО при provalidated bundle + доказанной эквивалентности + verdict='passed'.
 */
export function produceStrategyEvidence(input: StrategyEvidenceInput): ProduceStrategyResult {
  // (1) abort-before-sign gate — acceptance-gate validateBundle ПЕРЕД любым прогоном к подписи
  const ctx = platformContractContext([{ id: input.bundle.manifest.id, version: input.bundle.manifest.version }]);
  const gate = validateBundle(input.bundle, ctx);
  if (gate.status === 'rejected') {
    throw new Error(`bundle validation rejected — return to lab; no evidence emitted: ${JSON.stringify(gate.issues)}`);
  }

  // (2) twin-equivalence — расхождение ⇒ конкретный бар + diff
  const eq = compareBacktestRuns(input.curated, input.candidate);
  if (!eq.equivalent) {
    const d = eq.firstDivergence;
    throw new Error(
      d ? `equivalence failed at trade #${d.index} field ${d.field}: expected ${String(d.expected)}, got ${String(d.actual)}`
        : `equivalence failed (result_hash mismatch; curated ${eq.curatedTradeCount} trades, candidate ${eq.candidateTradeCount})`,
    );
  }

  // (3) метрики → verdict (NEVER sign 'passed' иначе как из реальных метрик)
  if (input.candidate.status !== 'completed') throw new Error('candidate run not completed');
  const metrics = computeMetrics(
    ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'],
    input.candidate.baseline.evidence.equityCurve,
    input.candidate.baseline.trades,
  );
  const verdict = decideVerdict(metrics);
  if (verdict !== 'passed') throw new Error(`verdict ${verdict} — not signing`);

  // (4) sign — bundleHash из СЫРЫХ байтов (== computeBundleHash форма)
  const bundleHash = sha256BundleRef(input.bundleBytes);
  const body = buildEvidenceBody({ backtesterRunId: input.backtesterRunId, bundleHash, verdict, scope: input.scope, keyId: input.key.keyId });
  const artifact = signEvidence(body, input.key.privateKey) as SignedBacktestEvidence;
  return { artifact, artifactRef: artifactRef(serializeArtifact(artifact)), bundleHash, keyId: input.key.keyId, verdict };
}
```
> Сверить точную сигнатуру `computeMetrics` (порядок аргументов: metrics, equity, trades) и `buildEvidenceBody` поля через gortex ПЕРЕД записью. `validateBundle` импортируется из `acceptance-gate.js` (НЕ structural `sandbox/bundle.ts`).

- [ ] **Step 4: Запустить — пройдёт**

Run: `pnpm exec vitest run apps/backtester/test/produce-strategy-evidence.test.ts`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/backtester/src/evidence/produce-strategy-evidence.ts apps/backtester/test/produce-strategy-evidence.test.ts
git commit -m "feat(evidence): produceStrategyEvidence — gate→equivalence→verdict→sign (abort-before-sign)"
```

---

## Task 8 (опционально, если по пути): хвосты PR #57

Не блокироваться. Если по ходу затронуты файлы — подмести:
- README example prose (`packages/sdk/README*` / authoring-док) — выровнять worked-пример.
- `run.ts` `ModuleValidateRequest` verify — добить verify-ветку, если рядом.
- `await executor.close()` — проверить, что все executor'ы закрываются (worker `finally` уже зовёт `executor?.close?.()`).
- doc/test-полировки.

Каждый хвост — отдельный мелкий коммит `chore(sdk): …`. Если не по пути — пропустить.

---

## Финал (после всех задач)

- [ ] **Полный регресс:** `pnpm check` → EXIT=0 (typecheck + весь vitest; sandbox-integration скипается в WSL2).
- [ ] **Whole-branch ревью (opus)** + fix-волна (см. родительский workflow: requesting-code-review → receiving-code-review).
- [ ] **PR открыть, НЕ мержить** (оставить на решение человека).

---

## Self-Review (выполнено при написании плана)

**Spec coverage:** §3.1 engine-route → Tasks 1–4; §3.2 equivalence-harness → Tasks 5–6; §3.3 sign + abort-before-sign gate → Task 7; §5 тесты → Tasks 2,5,6,7; §6 не-цели соблюдены (long_oi-порт/reconcile не трогаем; momentum/overlay byte-parity — гарды в Tasks 4,6); §2 контракт — Global Constraints. DoD §7 → финальный блок.

**Placeholder scan:** код приведён для всех новых юнитов (enum, builder, wrapper, dispatch-ветка, compareBacktestRuns, produceStrategyEvidence). Места «сверить точную сигнатуру через gortex / скопировать sandbox-assemble из overlay-sandbox-materialize.test.ts» — это явные инструкции выверки имён по существующему коду, НЕ отложенная логика.

**Type consistency:** `buildInlineOverlayRegistry(overlayBundles, strategyBundles=[])` одинаково в Tasks 2/4/6; `runStrategyBacktest(request, {registry,marketTape?,router?})` одинаково в Tasks 3/4/6; `compareBacktestRuns(curated, candidate): EquivalenceResult` одинаково в Tasks 5/6/7; `produceStrategyEvidence(StrategyEvidenceInput)` согласован с импортами evidence/. `RunOutcome.completed.baseline.{trades,evidence.equityCurve}` используется единообразно.
