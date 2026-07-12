# E5a — Hypothesis novelty gate (advisory) design

Date: 2026-07-12. Phase E, ROADMAP item 24. Predecessors: `docs/FEATURE-PARITY.md` (§4 E5, §5.3
family-identity layer **L3**), E2 (trial ledger — the durable-store template), E1a
(`dsrInputsFromEquity` / equity-curve conventions).

## Goal

Give the LLM refine loop a **behavioral novelty signal**: how correlated is a candidate's daily
PnL-delta trajectory with the trajectories of prior runs on the same market? A candidate that merely
rephrases an already-explored idea trades almost identically — high `|ρ|`, low novelty. This is the
behavioral final arbiter of hypothesis-family identity (**L3**): it crosses hypothesis families
(different `trialFamilyHint`, different code) and catches an old family passed off as a new one, which
the lab-side lexical/semantic layers (L1/L2) and the exact-fingerprint layer (L0) cannot see.

E2 and E5 are two ends of one anti-overfitting defense: **E2 punishes search *within* an acknowledged
family** (trial count N inflates the DSR hurdle); **E5 stops an old family being counted as new**
(correlated ⇒ same family ⇒ effective N should not reset).

Advisory + dark-launched, identical to every Phase E slice: `BACKTESTER_NOVELTY_ENABLED` default OFF,
result rides a **non-hashed** summary projection, `result_hash` byte-identical, `decideVerdict`
untouched.

## Scope

- **In:** pure `apps/backtester/src/engine/novelty.ts`; the durable `NoveltyPool` store
  (`src/jobs/ledger/novelty-pool.ts` InMemory + `pg-novelty-pool.ts` Pg + migration); the SDK
  `Novelty` contract type; config (flag + two validated thresholds); flag-gated worker-finalize
  wiring (overlay/strategy).
- **Out (E5b / later):** retro-merging E2-ledger families on a confirmed L3 match (fixing the DSR N
  counter); BRAIN-style escape hatch (Sharpe ≥ +10 % overrides a duplicate); AST largest-common-subtree
  similarity; MMC-style orthogonal-contribution scoring; lab-side RAG / Outcome-Embargo consumption;
  momentum path (no clean equity pairing at that seam — not evaluated, consistent with E2/E4a/E1b).

## Pure module — `src/engine/novelty.ts`

Three pure functions, no I/O, fully unit-testable.

### `toDailyPnlDeltas(equity): DailyDelta[]`

`DailyDelta = { day: string /* 'YYYY-MM-DD' UTC */, delta: number }`.

Bucket `equity` points by UTC calendar day (from `barTs`, ms epoch). Take each day's **close**
(the last point of that day). Emit `delta_i = close_i − close_{i-1}` for each **adjacent available
close-day pair**, in ascending day order; the emitted `DailyDelta` is **labelled with the later
close-day** (`day = day_i`) — this label is the intersection-alignment key, so both series must agree
on the convention. The first close-day is dropped (no predecessor).

- **Deltas are absolute** (equity-unit close-to-close differences), NOT percentages. Pearson is
  scale-invariant, so the same strategy run at 2× size still yields `ρ = 1` (correctly the same
  family), and there is no division-by-zero when equity crosses zero.
- **Gap semantics (fixed):** deltas are computed between **adjacent *available* close-days only**.
  Missing UTC calendar days (weekends, data gaps) do **not** synthesize zero deltas — a 3-day gap
  produces one delta spanning it, not three. Documented so the correlation domain is unambiguous.
- Flat days (`close_i == close_{i-1}`) legitimately produce `delta = 0`.

### `pnlDeltaCorrelation(a, b, minOverlapDays): { rho: number; overlapDays: number } | null`

Align `a` and `b` on the **intersection of their `day` labels**; Pearson `ρ` over the deltas on those
shared days. Returns `null` when `overlapDays < minOverlapDays`, or when either aligned series has
zero variance (Pearson undefined). `rho` is `quantize`d.

### `computeNovelty(candidate, pool, opts): Novelty`

`candidate: DailyDelta[]`; `pool: readonly PoolMember[]` where
`PoolMember = { ref: string; runId: string; dailyDeltas: DailyDelta[] }`;
`opts = { minOverlapDays, threshold, comparabilityKey }`.

Pure status derivation (the wiring layer only supplies the pool and decides persistence):

1. `candidate.length < 2` ⇒ `{ status:'no_comparators', reason:'empty_candidate', comparabilityKey, policy }`
   (a degenerate run has no correlatable trajectory).
2. `pool` empty ⇒ `{ status:'no_comparators', reason:'empty_pool', comparabilityKey, policy }`.
3. Compute `pnlDeltaCorrelation(candidate, m, minOverlapDays)` for each `m`; keep the non-null
   results (`comparators`). If none ⇒ `{ status:'no_comparators', reason:'insufficient_overlap',
   comparabilityKey, policy }`.
4. Else `maxAbsCorrelation = max |ρ|` over comparators; the **nearest** member is the arg-max, ties
   broken by smallest `ref` lexicographically (deterministic). Return
   `{ status:'resolved', score: 1 − maxAbsCorrelation, maxAbsCorrelation, nearest, comparabilityKey,
   comparedAgainst: comparators.length, behavioralDuplicate: maxAbsCorrelation ≥ threshold, policy }`.

`policy = { threshold, minOverlapDays }` (provenance — a flag's meaning depends on the thresholds).

## Contract (SDK, additive, NON-hashed)

```ts
export interface NoveltyNearest {
  readonly ref: string;       // resultHash — stable across replay / re-stamp; tie-break key
  readonly runId: string;     // human-friendly pointer to the nearest run
  readonly correlation: number;   // signed ρ (not abs) — a strong negative ρ is still a relative
  readonly overlapDays: number;
}
export type Novelty =
  | {
      readonly status: 'resolved';
      readonly score: number;              // 1 − maxAbsCorrelation; 1 = fully novel, 0 = exact twin
      readonly maxAbsCorrelation: number;
      readonly nearest: NoveltyNearest;
      readonly comparabilityKey: string;
      readonly comparedAgainst: number;    // pool members that met minOverlapDays
      readonly behavioralDuplicate: boolean;   // maxAbsCorrelation ≥ threshold
      readonly policy: { readonly threshold: number; readonly minOverlapDays: number };
    }
  | {
      readonly status: 'no_comparators';
      readonly reason: 'empty_pool' | 'insufficient_overlap' | 'empty_candidate';
      readonly comparabilityKey: string;
      readonly policy: { readonly threshold: number; readonly minOverlapDays: number };
    };
// RunResultSummary += novelty?: Novelty   (absent when the flag is OFF)
```

`comparabilityKey` rides **both** variants so a consumer always sees which pool the score was (or was
not) computed against.

## NoveltyPool store — `src/jobs/ledger/{novelty-pool,pg-novelty-pool}.ts`

Append-only, durable (InMemory + Pg, mirroring E2's `TrialLedger`). Never part of any hashed payload.

- **comparabilityKey** = `sha256(canonicalJson({ datasetRef, symbols: [...symbols].sort(), timeframe }))`
  — deliberately **no `period`, no `trialFamilyHint`**: L3 must cross families and cross shifted
  windows (period overlap is handled at correlation time by the shared-day intersection, not by the
  key). This is a *different* grouping from E2's `familyKey` (which includes both).

```ts
export interface PoolRecord {
  readonly comparabilityKey: string;
  readonly requestFingerprint: string;  // dedupe axis with comparabilityKey
  readonly runId: string;
  readonly resultHash: string;
  readonly familyKey?: string;          // OPTIONAL — E5 is not coupled to E2; stored for a future L3 retro-merge
  readonly dailyDeltas: readonly DailyDelta[];
  readonly createdAtMs: number;
}
export interface NoveltyPool {
  /** Idempotent on (comparabilityKey, requestFingerprint); true iff a new row was inserted. */
  recordIfNew(r: PoolRecord): Promise<boolean>;
  /**
   * Members of a comparability group, ordered created_at_ms ASC, run_id ASC (stable).
   * `excludeRequestFingerprint` drops the caller's own already-recorded row — REQUIRED for
   * self-exclusion under replay (see below).
   */
  query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]>;
}
```

**Replay self-exclusion (idempotent projection).** `query → score → record` self-excludes on the
*first* run (the pool has no candidate yet), but a **replay of the same `requestFingerprint`** after
that run was recorded would `query` and see itself — yielding `ρ = 1`, `behavioralDuplicate: true`, a
different projection for the same request. To keep the projection idempotent, `query` MUST exclude the
caller's own fingerprint: `query(comparabilityKey, { excludeRequestFingerprint: currentRequestFingerprint })`.
`recordIfNew` still runs after scoring (and is itself a no-op on replay).

- Dedupe on `(comparabilityKey, requestFingerprint)` so a replay / result-cache hit does not add a
  duplicate trajectory. Same bundle on a different period ⇒ same `comparabilityKey`, different
  `requestFingerprint` ⇒ a legitimate second sample.
- `dailyDeltas` is a small array (days, not bars) — stored inline.

### Pg schema (migration `0008_novelty_pool.sql`)

```sql
CREATE TABLE novelty_pool (
  comparability_key   text        NOT NULL,
  request_fingerprint text        NOT NULL,
  run_id              text        NOT NULL,
  result_hash         text        NOT NULL,
  family_key          text,                 -- nullable: E5 decoupled from E2
  daily_deltas        jsonb       NOT NULL,
  created_at_ms       bigint      NOT NULL,
  PRIMARY KEY (comparability_key, request_fingerprint)
);
CREATE INDEX novelty_pool_by_key ON novelty_pool (comparability_key);
```

`query` selects `WHERE comparability_key = $1` (plus `AND request_fingerprint <> $2` when
`excludeRequestFingerprint` is given) `ORDER BY created_at_ms ASC, run_id ASC`. Ordering is for
determinism of the returned list; the score itself is order-independent (nearest tie-break is by
`ref`, and `max` is commutative). The InMemory store applies the same filter after lookup.

## Wiring — worker finalize (overlay/strategy, flag-gated)

After `finalizeResult` (resultHash fixed), when `deps.novelty?.enabled`, an exported helper does the
work. Its signature carries the **full finalize context** — `comparabilityKey`,
`requestFingerprint`, `runId`, `resultHash`, and the optional `familyKey` all come from the job, not
the outcome — so the implementation cannot drift from the spec:

```ts
export interface NoveltyContext {
  readonly request: BacktestRunRequest;   // market context → comparabilityKey (+ optional familyKey)
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly outcome: RunOutcome;           // equity curve source
}
export function resolveNovelty(deps: WorkerDeps, ctx: NoveltyContext): Promise<Novelty | undefined>;
```

(mirrors `resolveHoldoutMarker` / `resolveRunDiagnostics`, wiring-tested). Steps:

1. `candidateDeltas = toDailyPnlDeltas(ctx.outcome.baseline.evidence.equityCurve)`.
2. `comparabilityKey` from `ctx.request` market context.
3. `pool = await deps.novelty.pool.query(comparabilityKey, { excludeRequestFingerprint: ctx.requestFingerprint })`
   — self-exclusion under replay (above).
4. `novelty = computeNovelty(candidateDeltas, pool.map(toPoolMember), { minOverlapDays, threshold, comparabilityKey })`.
   - `toPoolMember(r) = { ref: r.resultHash, runId: r.runId, dailyDeltas: r.dailyDeltas }`.
5. **Record iff `candidateDeltas.length >= 2`** (i.e. not `empty_candidate`) — a degenerate run must
   not pollute the pool with a useless vector: `await deps.novelty.pool.recordIfNew({ comparabilityKey,
   requestFingerprint: ctx.requestFingerprint, runId: ctx.runId, resultHash: ctx.resultHash,
   ...(familyKey ? { familyKey } : {}), dailyDeltas: candidateDeltas, createdAtMs })`. `familyKey` is
   set only when the E2 family helper is available/computed; otherwise omitted.
6. Return `novelty`.

**Order is query → score → record**, and `query` excludes the caller's own fingerprint: the candidate
is scored against the *prior* pool only, never itself — on the first run OR a replay. Attach `novelty`
to the summary projection **after** `contentRef(payload)`, never inside it. Flag OFF ⇒ no field ⇒
byte-identical. Momentum path not evaluated.

`WorkerDeps += novelty?: { enabled: boolean; threshold: number; minOverlapDays: number; pool: NoveltyPool }`.

## Config (dark-launch, default OFF)

- `BACKTESTER_NOVELTY_ENABLED` (bool, default OFF).
- `BACKTESTER_NOVELTY_CORR_THRESHOLD` (default `0.80`) — `behavioralDuplicate` when
  `maxAbsCorrelation ≥ threshold` (stricter than AlphaMemo's 0.70 admission bar to cut false-positive
  duplicates). **Validated: must be in `[0, 1]`.**
- `BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS` (default `30`) — minimum shared days for a valid Pearson.
  **Validated: integer `≥ 1`** (correlation over 0 days is impossible).

Validation is **fail-fast only when the flag is enabled** (mirrors E4a's `holdoutFraction`): a
`NoveltyConfigError` is thrown from `loadConfig` if `enabled` and `threshold ∉ [0,1]` or
`minOverlapDays` is not an integer `≥ 1`. When **disabled**, `loadConfig` does **not** throw and the
bad values are never used — the parser normalizes an unparseable/out-of-range env to the default
(`0.80` / `30`) so the `AppConfig` object never carries `NaN` even with the flag OFF.
(`nonNegNumEnv` from PR #113 is deliberately NOT used here — it would admit `threshold > 1` and
`minOverlapDays = 0`.)

## Determinism / invariant

`novelty` is a function of the run **and the current pool state** (like `trialContext`), so it lives
on the NON-hashed summary projection only. Flag OFF ⇒ absent ⇒ goldens byte-identical, API-response
shape changes only when the flag is on. `decideVerdict` untouched — advisory.

## Testing (TDD)

**pure `novelty.ts`:**
- `toDailyPnlDeltas`: multi-point-per-day → daily close taken; adjacent-available-day deltas; a
  weekend/data gap produces ONE spanning delta, not zero-filled days; a flat day → `delta 0`; a
  single close-day → empty array (`< 2` deltas).
- `pnlDeltaCorrelation`: identical series → `ρ = 1`; scaled series (2×) → `ρ = 1` (scale-invariance);
  anti-correlated → `ρ = −1`; disjoint days → `null`; overlap below `minOverlapDays` → `null`;
  zero-variance series → `null`.
- `computeNovelty`: `empty_candidate` (`< 2` deltas); `empty_pool`; `insufficient_overlap` (members
  exist, none meet overlap); `resolved` with `score = 1 − maxAbs`, correct `nearest`, `comparedAgainst`,
  `behavioralDuplicate` toggling at `threshold`; nearest **tie-break by `ref`** when two members share
  `maxAbs`; `comparabilityKey` present in every branch.

**store:** `recordIfNew` dedupe on `(comparabilityKey, requestFingerprint)` (replay → `false`, no
second row); different period, same key → two rows; `query` returns members in `created_at_ms ASC,
run_id ASC` order; `query(key, { excludeRequestFingerprint })` omits the caller's own row; empty
group → `[]`.

**config:** default OFF, defaults `0.80` / `30`; exact-`true` enables; custom values parsed;
fail-fast `NoveltyConfigError` when enabled with `threshold = 1.5`, `threshold = -0.1`,
`minOverlapDays = 0`, `minOverlapDays = 2.5`; disabled + bad values → no throw **and** the stored
config carries the defaults, not `NaN`.

**wiring:** flag OFF ⇒ no `novelty` field + golden `result_hash` unchanged; flag ON, empty pool ⇒
`no_comparators:empty_pool` **and** the run IS recorded (a subsequent identical-market run sees it);
flag ON, `empty_candidate` (degenerate equity) ⇒ `no_comparators:empty_candidate` **and** NOT
recorded; flag ON with a seeded correlated pool member ⇒ `resolved` with `behavioralDuplicate: true`
and the correct `nearest.ref`; **replay** of an already-recorded run ⇒ `query` self-excludes ⇒ NOT
`behavioralDuplicate` against itself (idempotent projection).

## Out of scope

E2-ledger family retro-merge on a confirmed L3 match; BRAIN escape hatch; AST / MMC similarity; the
lab-side RAG memory + Outcome-Embargo; the momentum path.
