# Дизайн: signed backtest-evidence/v1 через HTTP/worker strategy-submit

**Дата:** 2026-06-28
**Статус:** утверждён (брейншторм делегирован), готов к плану
**Контекст:** `POST /v1/runs` (engine:'strategy') сейчас → worker `runStrategyBacktest` → `resultHash`
(НЕ evidence). `produceStrategyEvidence`/`produceStrategyEvidenceForBundle` имеют ноль вызовов —
не подключены. Цель: strategy-submit → curated-vs-candidate equivalence → подписанный
`backtest-evidence/v1`, retrievable через результат рана. Это нога lab→backtester-sign→platform-admit.

---

## 1. Ground truth (выверено по коду)

- App-pipeline strategy-ветка: `apps/backtester/src/jobs/worker.ts::processNextQueued`
  (`else if (claimed.request.engine === 'strategy')`) — материализует бандл (`sandboxBundleFor` →
  `sandboxBundle.bundle`), `buildInlineOverlayRegistry([], [bundle])`, `runStrategyBacktest` →
  `resultHash = contentRef(outcome)`, `persistOverlayArtifacts`, `toOverlaySummary`.
- `produceStrategyEvidence(input: StrategyEvidenceInput)` (src/evidence/produce-strategy-evidence.ts:54) —
  принимает **injected** `{ bundle, bundleBytes, curated, candidate, scope, key, backtesterRunId }`,
  порядок gate→equivalence→verdict→sign, throws на любом провале до подписи, returns
  `ProduceStrategyResult { artifact, artifactRef, bundleHash, keyId, verdict:'passed' }`.
- `produceStrategyEvidenceForBundle` (driver) сам прогоняет curated+candidate — для standalone
  вызывателей (lab/scripts); worker НЕ использует его (candidate уже прогнан).
- `RunResultSummary` (packages/sdk/src/contracts/run.ts:118) = `{ runId, status, metrics,
  artifactRefs: ArtifactReference[], evidence: RunEvidence, resultHash?, comparison? }`.
- `toOverlaySummary` (apps/backtester/src/jobs/overlay-summary.ts:13) проецирует RunOutcome → summary.
- `persistOverlayArtifacts` (artifacts/overlay-store.ts:21): `store.write(payload) → contentHash`,
  возвращает `ArtifactReference { artifactId: contentHash, artifactType, availability }`.
- `AppConfig`/`WorkerDeps` — НЕТ signing-key поля (добавляем).
- `BacktestRunRequest`/`RunSubmitRequest` (run.ts:19/44) — `Ref = { id, version }` уже есть.
- curated baseline в backtester = ТОЛЬКО `shortAfterPump` (trusted, TRUSTED_REGISTRY_DEFINITION).
  Long_oi curated нет — для non-twin бандла equivalence разойдётся → abort-before-sign (корректно).

---

## 2. Контракт (заморожен — НЕ менять)

`backtest-evidence/v1`; `canonicalizeEvidenceBody` = байт-точный mirror платформы
(`src/admissions/verification/evidence-verifier.ts`: sorted-keys, без `\n`, без quantization);
detached Ed25519 над `canonicalize(body)`; `body.bundleHash = sha256BundleRef(rawBytes)` сырых
ESM-байтов (Вариант 2); `keyId`. Всё переиспользуется из `src/evidence/` — никакой новой
канонизации/подписи. См. инвариант `mem379570b265428f07`.

---

## 3. Целевая архитектура

### 3.1 Контракт (аддитивно, опционально)
- `BacktestRunRequest` += `readonly curatedBaselineRef?: Ref` — trusted baseline для evidence-сравнения.
  Прокидывается через `RunSubmitRequest` (наследует) и worker engineRequest.
- `RunResultSummary` += `readonly evidenceRef?: ArtifactReference` — указатель на подписанный артефакт.
- Оба additive optional. resultHash-путь (lab F1 status:'equivalent') не затронут.

### 3.2 Signing-key (config)
- `AppConfig` += `readonly evidenceSigningKeyPem?: string` ← env `BT_EVIDENCE_SIGNING_KEY`.
- `loadConfig` читает env (как остальные опц. поля). HTTP-app/worker-bootstrap: если PEM задан →
  `evidenceSigningKey = loadSigningKeyFromPem(pem)` (`src/evidence/signing.ts`) → в `WorkerDeps`.
- `WorkerDeps` += `readonly evidenceSigningKey?: SigningKey`.
- **Ключа нет → evidence OFF** (нет эфемерных ключей — их keyId не в platform allowlist).

### 3.3 Worker strategy-ветка (run-once, аддитивно)
После существующего `runStrategyBacktest` (resultHash) + `persistOverlayArtifacts`, ДО `toOverlaySummary`:
```ts
let evidenceRef: ArtifactReference | undefined;
if (claimed.request.curatedBaselineRef !== undefined && deps.evidenceSigningKey !== undefined) {
  try {
    // curated: trusted baseline, in-process, ТОТ ЖЕ marketTape (дёшево, без sandbox)
    const curated = await runOverlayBacktest(
      { ...engineRequest, moduleRef: claimed.request.curatedBaselineRef },
      { registry: buildTrustedRegistry(), marketTape },
    );
    if (curated.status !== 'completed') throw new Error('curated baseline run not completed');
    // raw ESM bytes сабмиченного бандла (Вариант-2 flat: files[entry])
    const bundleBytes = Buffer.from(sandboxBundle!.bundle.files[sandboxBundle!.bundle.entry], 'utf8');
    const scope: EvidenceScope = {
      datasetRef: r.datasetRef,
      window: { fromMs, toMs },         // из r.period
      symbols: [...r.symbols].sort(),
      timeframe: r.timeframe,
    };
    const result = produceStrategyEvidence({
      bundle: sandboxBundle!.bundle, bundleBytes, curated, candidate: outcome,
      scope, key: deps.evidenceSigningKey, backtesterRunId: runId,
    });
    const evidenceHash = await deps.artifactStore.write(result.artifact);
    evidenceRef = { artifactId: evidenceHash, artifactType: 'backtest-evidence', availability: 'available' };
  } catch (err) {
    // gate-reject / non-equivalent (non-twin) / verdict!=passed / no key → НЕ ломаем ран
    // log; evidenceRef остаётся undefined
  }
}
```
> `sandboxBundle.bundle` — материализованный host-side ModuleBundle (для acceptance-gate внутри
> produceStrategyEvidence). `bundleBytes` — сырые байты entry (Вариант-2); `produceStrategyEvidence`
> хеширует их в `bundleHash` (lab-pinned raw bytes, НЕ пересчёт из bundleDir). Точное поле для raw
> bytes (inline `files[entry]` ∨ bundleStore blob) — выверить при имплементации; должно равняться
> сабмиченным байтам (driver H2-инвариант это пинит).

### 3.4 Retrieval
`toOverlaySummary` получает доп. опц. аргумент `evidenceRef?` и кладёт его в `RunResultSummary.evidenceRef`.
Сами байты артефакта фетчатся из ArtifactStore по `evidenceRef.artifactId` (как любой артефакт).

### 3.5 Error handling (guardrail)
Evidence-блок целиком в try/catch. Любой провал → log + `evidenceRef` undefined; ран завершается
`completed` с `resultHash`. resultHash-путь нерушим. momentum/overlay ветки не трогаются.

---

## 4. Изоляция компонентов

| Юнит | Что | Зависимость |
|---|---|---|
| `curatedBaselineRef`/`evidenceRef` контракт | opt-in trigger + retrieval pointer | run.ts типы |
| `evidenceSigningKeyPem` config + `evidenceSigningKey` dep | источник ключа (env, off-if-absent) | signing.ts |
| worker evidence-блок | run-once curated + produceStrategyEvidence + persist | produceStrategyEvidence (готов), runOverlayBacktest (готов), artifactStore |
| `toOverlaySummary(+evidenceRef?)` | проброс в summary | RunResultSummary |

---

## 5. Тестирование

- **worker integration (Docker)** `strategy-evidence-http.integration.test.ts`: HTTP submit
  short_after_pump twin + `curatedBaselineRef:{id:'short_after_pump',version:'0.1.0'}` + сконфигуренный
  ключ → drain → terminal `completed` + `summary.evidenceRef` defined → фетч артефакта из store →
  `verifySignedEvidenceLocal(artifact, {[keyId]: pubPem}).ok` + body `schema:'backtest-evidence/v1'`,
  `bundleHash` `/^sha256:[0-9a-f]{64}$/`, `verdict:'passed'`.
- **negative**: (a) без `curatedBaselineRef` → нет `evidenceRef` (только resultHash) — может быть
  non-Docker если не доходит до sandbox; реалистично Docker-gated. (b) без ключа → нет evidenceRef.
- **regression**: momentum golden + overlay golden + existing strategy resultHash-путь зелёные;
  `pnpm check` EXIT 0.

---

## 6. Scope / не-цели

**В scope:** `curatedBaselineRef` + `evidenceRef` контракт; signing-key config/dep; worker evidence-блок
(run-once); retrieval через summary; тесты; регресс зелёный; PR (не мержить).

**Не-цели:** менять backtest-evidence/v1 / canonical / computeBundleHash контракт; трогать lab; long_oi
curated (его нет — non-twin не выпускает evidence, корректно); driver (остаётся standalone); momentum/overlay
byte-parity не трогаем; реальный обмен ключами с платформой (cross-repo follow-on ниже).

**Cross-repo follow-on (отмечено, не делаю):** публичный Ed25519-ключ backtester'а (keyId из
`export-signer-pubkey`) → платформенный `trustedSigners` allowlist (платформенная сторона).

---

## 7. Готовность (DoD)

1. strategy-submit с `curatedBaselineRef` + сконфигуренным ключом → curated-vs-candidate equivalence →
   `produceStrategyEvidence` → подписанный `backtest-evidence/v1`, retrievable через `summary.evidenceRef`.
2. Контракт байт-совместим с платформенным verifier (переиспользует `src/evidence/`).
3. Без `curatedBaselineRef`/ключа ∨ при non-equivalent candidate → ран `completed` с resultHash, без evidence (аддитивно).
4. keyId-allowlist отмечен как cross-repo follow-on.
5. `pnpm check` EXIT 0; PR открыт, не смержен.
