# Дизайн: engine-роутинг `kind:'strategy'` + equivalence-harness + sign-evidence

**Дата:** 2026-06-27
**Статус:** утверждён (брейншторм), готов к плану
**Контекст:** эскалация системного gap из Task 7 / PR #57 (SDK 0.3.0). Полный lifecycle бандла
`kind:'strategy'` не исполняется через app-pipeline движка. Задача — закрыть gap, доказать
эквивалентность доставки стратегии (trusted ↔ bundle) на backtest и произвести подписанный
`backtest-evidence/v1` для платформенного admission.

---

## 1. Ground truth (выверено по коду, не по описанию)

### 1.1 Как движок роутит исполнение

- **App-pipeline** = `apps/backtester/src/jobs/worker.ts::processNextQueued` (worker.ts:115).
  Единственная развилка (worker.ts:131): `if (request.engine === 'overlay')` → engine-runner
  через `runOverlayBacktest`; иначе → legacy momentum-путь (`run-backtest.ts::runBacktest`,
  интерфейс `computeSignals` / `signals()`). **Ветки `'strategy'` нет.**
- `BacktestEngine` enum = `'momentum' | 'overlay'`.
- **Роутинг в sandbox — по `provenance`, НЕ по `kind`**: `sandbox/routing.ts::route` (routing.ts:185)
  отправляет резолвнутый модуль в sandbox при `provenance === 'bundle' && bundle !== undefined`,
  иначе — в trusted in-process executor. `forStrategy` и `forOverlay` идентичны (движок симметричен).
- **Strategy-lifecycle хуки** (`onBarClose` / `onPositionBar`) **уже исполняются** в живом
  пайплайне: `engine/runner.ts::runSymbol` (runner.ts:311) → `simulateTarget` (runner.ts:512)
  → engine `runBacktest` (runner.ts:618). Гейт на `module.onBarClose !== undefined` /
  `position !== null && module.onPositionBar !== undefined`.
- `manifest.kind` (`'strategy' | 'overlay'`) читается только в SDK preflight
  `engineMatchesKind` (packages/sdk/src/builder/preflight.ts:35) — НЕ в раннере.

### 1.2 Где именно gap (smoking gun)

- `createModuleRegistry` (sandbox/routing.ts:105) **уже имеет канал `strategyBundles`** и корректно
  ставит `provenance:'bundle'` + `bundle:b` (через `createInertStrategyModule(b.manifest)`).
  То есть весь engine-слой (registry → provenance → `router.forStrategy` → sandbox
  `SandboxModuleExecutor.executeStrategyHook` (sandbox-executor.ts:128) → `runSymbol` lifecycle)
  **уже готов и протестирован.**
- Не хватает ровно **двух стежков проводки**:
  1. `buildInlineOverlayRegistry` (trusted-registry.ts:22) пробрасывает только `overlayBundles`;
     `strategies` жёстко = `TRUSTED_REGISTRY_DEFINITION.strategies`. Канал `strategyBundles`
     наружу не выведен.
  2. `processNextQueued` не имеет ветки, которая кладёт submitted strategy-kind бандл в
     baseline-слот и выбирает engine-runner.

### 1.3 Якорь эквивалентности

- В backtester **нет** curated/trusted стратегии `long_oi`. Единственная trusted-стратегия —
  `shortAfterPump` (`engine/examples/short-after-pump.strategy.ts`, зарегистрирована в
  `TRUSTED_REGISTRY_DEFINITION.strategies`). `long_oi` встречается лишь как `targetStrategyRef`
  в overlay-фикстурах и как записанные paper-trades в снапшоте; порт логики `long_oi`
  невозможен из снапшота (`decisionsByRun` пуст — зафиксировано в spec-доках PR #51/#55).
- Готовый якорь: фикстура `apps/backtester/test/fixtures/overlay/bundles/short-after-pump.bundle.json` —
  это `kind:'strategy'` Вариант-2 бандл (flat self-contained ESM `export default createStrategyModule`,
  hooks `["onBarClose"]`), в комментарии помеченный как **«ПОБАЙТОВЫЙ ДВОЙНИК trusted
  shortAfterPump.onBarClose ⇒ тот же engine code path ⇒ тот же result_hash (golden 0be9931c)»**.
- **Решение (утв. пользователем):** equivalence якорим на short_after_pump twin — это «backtest-субстрат»
  платформенного proof 049 (платформа доказала bundle==curated в paper; backtester доказывает
  bundle-route==trusted-route в backtest). Нарратив = **delivery-equivalence**.

### 1.4 Sign-машинерия (уже есть, переиспользуем)

- `apps/backtester/src/evidence/`: `buildEvidenceBody` (body.ts), `signEvidence` /
  `generateSigningKey` / `loadSigningKeyFromPem` / `deriveKeyId` / `verifySignedEvidenceLocal`
  (signing.ts), `decideVerdict` + `DEFAULT_THRESHOLDS` (verdict.ts), `serializeArtifact` /
  `artifactRef` / `sha256BundleRef` (artifact.ts), `canonicalizeEvidenceBody` (canonical.ts —
  байт-точный mirror платформы; НЕ `determinism/canonical-json.ts`).
- `scripts/produce-evidence.mts::produceEvidence` уже прошивает flow
  backtest→metrics→`decideVerdict`→`sha256BundleRef`→`buildEvidenceBody`→`signEvidence`→artifact.
  Abort-before-sign seam = блок `TODO(real-bundle)` (validateBundle).

### 1.5 Гейт

- Зелёный гейт = одна команда `pnpm check` = `pnpm typecheck && pnpm test`
  (с pre-hooks: `sdk:build`, `build:sandbox-harness-overlay`, `vitest run`).
- Конвенция тестов — descriptive kebab-case (`<topic>.test.ts`; `*.integration.test.ts` для
  инфра/Docker). Числовые коды (017/019/042/051) живут в `describe()`, не в именах файлов.

---

## 2. Кросс-граничный контракт (НЕ менять — зафиксирован)

- Формат бандла = **Вариант 2**: flat self-contained ESM `export default createStrategyModule`,
  `bundleHash = computeBundleHash(rawBytes) = sha256(сырых байтов)`.
- Платформенная половина proof готова (feature 049): платформа принимает бандл тем же входом
  (`bundleId ∨ ESM-байты`), `sha256(bytes) == contentHash`. Контракт хеша/формата ОБЯЗАН совпадать.
- Формат evidence: `backtest-evidence/v1`, `SignedEvidenceBody`, canonical mirror, Ed25519 detached,
  `bundleHash = 'sha256:'+hex` — verифицируется платформой офлайн
  (`trading-platform/src/admissions/verification/evidence-verifier.ts`). См. инвариант
  `mem379570b265428f07`.

---

## 3. Целевая архитектура

### 3.1 Engine: strategy-route через app-pipeline

**Подход:** явный аддитивный селектор `engine:'strategy'` + проводка существующего `strategyBundles`-канала.

1. **Контракт запроса.** Добавить `'strategy'` в enum `BacktestEngine` (аддитивно — не ломает
   существующие значения). Обновить `engineMatchesKind` (preflight.ts:35):
   - `engine === 'overlay'` → `kind === 'overlay'`
   - `engine === 'strategy'` → `kind === 'strategy'`
   - `engine === 'momentum'` (дефолт) → `kind === 'strategy'` (без изменений; momentum «потребляет»
     strategy-модули через signals()).
2. **Registry builder.** `buildInlineOverlayRegistry(overlayBundles)` → добавить опциональный
   параметр `strategyBundles: readonly ModuleBundle[] = []` и пробросить его в
   `createModuleRegistry({ ..., strategyBundles })`. Overlay-путь остаётся **байт-идентичным**
   (передаёт `[]`). Single source of truth сохраняется.
3. **Новый wrapper `runStrategyBacktest`** (зеркало `run-overlay.ts::runOverlayBacktest`):
   запускает engine-runner с submitted strategy-бандлом как baseline, **без overlays** →
   baseline-only lifecycle-прогон. `route.forStrategy` уводит baseline в sandbox
   (`provenance:'bundle'`). Снимает non-contract поле `engine` перед вызовом engine `runBacktest`.
4. **Dispatch `processNextQueued`** (worker.ts:131): новая ветка `else if (request.engine === 'strategy')`:
   - материализовать бандл из `claimed.bundleHash` (`sandboxBundleFor`);
   - assert `materialized.manifest.kind === 'strategy'` (иначе — reject job, не silently);
   - собрать registry: `buildInlineOverlayRegistry([], [bundle])` (strategy в baseline-слот,
     overlays пусты);
   - `baselineRef` = `{ id: manifest.id, version: manifest.version }`;
   - прогнать `runStrategyBacktest(engineRequest, { registry, marketTape, router: sandboxRouter })`.
5. **Инварианты:**
   - momentum (signals()) и overlay-роутинг — без изменений (новая ветка + дефолт-пустой параметр);
   - существующий регресс (overlay-golden, momentum-guardrail, rows-parity, golden-sync,
     validator-kernel-equivalence) остаётся зелёным;
   - sandbox-исполнение по per-bar IPC уже покрыто; новых seam'ов в executor не вводим.

### 3.2 Equivalence-harness

- **Reusable-функция** (в `src/`, не только в тесте) `compareBacktestRuns(curated, candidate)`:
  принимает два результата backtest (trusted baseline и bundle-route), возвращает
  `{ equivalent: boolean; resultHashMatch: boolean; firstDivergence?: { bar: number; field: string;
  expected: unknown; actual: unknown }; tradeDiff: TradeDiff[] }`.
  - Сравнение по слоям: (1) `result_hash` (байт-якорь, golden `0be9931c`); (2) per-trade economics
    (entry/exit ts, side, fill-цены, pnlPct) — на расхождении возвращает **первый расходящийся бар + diff**.
  - Чистая, без I/O (по образцу `helpers-reconcile.ts::reconcileTrades`).
- **Тест-сценарий** (`strategy-curated-equivalence`):
  - curated = `backtest(shortAfterPump trusted baseline)` через engine-runner (in-process executor);
  - candidate = `backtest(short_after_pump kind:'strategy' bundle)` через **новый** app-pipeline
    strategy-route (sandbox executor);
  - assert `equivalent === true` (result_hash + economics паритет).
- На реальном Docker-зависимом sandbox — `*.integration.test.ts` (в WSL2 Docker-тесты
  скипаются, CI — гейт sandbox-пути; см. async-ipc memory).

### 3.3 Sign-звено (полный lifecycle)

- Расширить `produce-evidence.mts` (или вынести в `src/evidence/` reusable `produceStrategyEvidence`):
  1. вход — short_after_pump strategy-bundle (ESM-байты ∨ материализованный bundle);
  2. прогнать equivalence-harness (§3.2); если `!equivalent` → throw, evidence не выпускается
     (расхождение → бар + diff в сообщении);
  3. **abort-before-sign gate** (утв. пользователем): `validateBundle(bundle, ...)` из
     `src/sandbox/bundle.ts` / acceptance-gate ПЕРЕД подписью; `rejected` ⇒
     `throw new Error('bundle validation rejected — return to lab; no evidence emitted')`;
  4. `computeMetrics` → `decideVerdict`; `verdict !== 'passed'` ⇒ не подписывать
     (`NEVER sign 'passed' unless computed from real metrics`);
  5. `sha256BundleRef(bundleBytes)` (== `computeBundleHash` форма) → `buildEvidenceBody({ scope, … })`
     → `signEvidence(body, key.privateKey)` → `serializeArtifact` / `artifactRef`.
- **Scope** evidence: `datasetRef` / `window {fromMs,toMs}` / `symbols` (sorted) / `timeframe`
  берутся от датасета short_after_pump golden-прогона (тот же, на котором посчитан golden 0be9931c).
- Контракт подписи/хеша строго через `src/evidence/` — байт-идентичность платформенному верификатору.

---

## 4. Изоляция компонентов

| Компонент | Что делает | Зависит от |
|---|---|---|
| `engine:'strategy'` enum + `engineMatchesKind` | контракт выбора strategy-route | preflight |
| `buildInlineOverlayRegistry(overlayBundles, strategyBundles=[])` | проводка strategy в baseline-слот | `createModuleRegistry` (готов) |
| `runStrategyBacktest` | baseline-only lifecycle прогон бандла | engine-runner (готов), router (готов) |
| `processNextQueued` strategy-ветка | dispatch app-pipeline | wrapper + builder + materialize |
| `compareBacktestRuns` | byte/economics паритет + first-divergence diff | чистая, без I/O |
| `produceStrategyEvidence` | equivalence→gate→verdict→sign | evidence/ (готов) + harness + validateBundle |

Каждый юнит тестируем независимо; границы — через явные интерфейсы (результаты backtest, ModuleBundle,
SignedEvidenceBody).

---

## 5. Тестирование (TDD)

- `strategy-route.test.ts` — kind:'strategy' бандл роутится через app-pipeline (worker dispatch
  выбирает strategy-route; baseline резолвится с `provenance:'bundle'`; lifecycle-хуки вызываются).
- `strategy-curated-equivalence.test.ts` (или `.integration.test.ts`) — twin-паритет
  trusted ↔ bundle (result_hash + economics); негативный кейс: искусственное расхождение →
  harness возвращает конкретный бар + diff.
- расширение evidence-теста: abort-before-sign gate (rejected bundle ⇒ no artifact);
  happy-path ⇒ подписанный артефакт верифицируется `verifySignedEvidenceLocal`.
- Регресс-гейт `pnpm check` EXIT=0 (включая существующие byte-parity/golden гейты — зелёные).

---

## 6. Scope / не-цели

**В scope:**
- engine strategy-route через app-pipeline (enum + builder + wrapper + dispatch);
- reusable equivalence-harness (byte/economics, first-divergence diff);
- sign-звено с abort-before-sign validateBundle gate;
- полный регресс зелёный (EXIT=0); PR открыт, **не смержен**.

**Не-цели:**
- настоящий `long_oi`-порт (невозможен из снапшота);
- reconcile vs записанные paper-trades (отдельный путь, не byte-parity);
- изменение momentum / overlay логики или их byte-parity инвариантов;
- изменение кросс-граничного контракта формата/хеша (Вариант 2) или формата evidence;
- warm-pool / L2 / multi-machine перф (перф-ладдер на паузе).

**Попутно (если по пути, не блокируемся):** минорные хвосты PR #57 — README example prose,
`run.ts` `ModuleValidateRequest` verify, doc/test-полировки, `await executor.close()`.

---

## 7. Готовность (Definition of Done)

1. Движок роутит `kind:'strategy'` lifecycle-бандл через app-pipeline (новый `engine:'strategy'`
   dispatch → baseline `provenance:'bundle'` → sandbox → `runSymbol` lifecycle).
2. Equivalence-harness зелёный: `backtest(short_after_pump bundle)` == `backtest(shortAfterPump
   trusted)` на backtest (result_hash + economics паритет); расхождение → конкретный бар + diff.
3. Sign-evidence производится: equivalence + validateBundle + verdict='passed' ⇒ подписанный
   `backtest-evidence/v1`, верифицируемый платформенным контрактом.
4. momentum + overlay регресс остаются зелёными; `pnpm check` EXIT=0.
5. PR открыт, **не смержен** (оставлен на решение человека).
