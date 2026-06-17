# Slice 6b-A — Sandboxed overlay-module execution (untrusted executor lift)

> Status: **approved design** (2026-06-17). Additive, flag-gated. Follows Slice 6a (the trusted
> overlay-engine lift, PR #5). Grounded in a read of trading-platform `src/research/sandbox/**`,
> `src/research/sandbox-harness/**`, `scripts/verify_020_equivalence.mjs`, and the example sandbox
> bundle fixtures under `specs/019-sandbox-module-gateway/fixtures/bundles/**`; plus the backtester's
> Slice-3 signals sandbox (`apps/backtester/src/sandbox/**`) and the 6a overlay engine
> (`apps/backtester/src/engine/**`).

---

## 0. One-sentence thesis

Lift trading-platform's per-bar-IPC **sandboxed `ModuleExecutor`** into trading-backtester as the
**untrusted** overlay execution path — a sibling to the trusted in-process executor Slice 6a landed —
so `engine:'overlay'` becomes reachable through **both** executors (selected explicitly by bundle
presence, never silently), with the sandboxed run producing a `RunOutcome` **byte-identical** to the
trusted one (same goldens `0be9931c` / `e381659c`). 6b-A is the prerequisite that unblocks the
trading-lab cutover (6b-B) and the `sp4_mock` retire (6b-C), both of which are **separate follow-up
specs**.

---

## 1. Background & problem

Slice 6a lifted the platform's `runBacktest` engine and runs it through the **trusted in-process
executor** (`createTrustedRegistry` over lifted TS example modules). `enableOverlayEngine` gates it
(default off); real `comparison` flows on `RunResultSummary`; parity is byte-for-byte vs the platform
(goldens `0be9931c` baseline / `e381659c` variant, proven by the `verify_018` HTTP gate).

What 6a deliberately left for 6b: **untrusted** overlay/strategy modules — submitted bundles — cannot
yet run. The lifted runner is pre-wired for it (`RunDeps.router` / `sandboxPolicyRef` /
`sandboxPolicies` were lifted verbatim and are currently unused), but there is no sandbox
`ModuleExecutor` behind that seam. trading-lab submits **untrusted bundles**, so its cutover off
`baselineOnlyComparison` and the `sp4_mock` retire both wait on this. The explicit blocker comment in
trading-lab `src/adapters/platform/backtester-bundle.ts` names exactly this gap.

The backtester's **Slice-3** sandbox (`apps/backtester/src/sandbox/**`) is a different thing: a
**signals-only, one-shot-container** executor implementing `src/runner/module-executor.ts`
(`computeSignals → boolean[]`, async), used by the **momentum + bundle** path. It is NOT mergeable
with the overlay sandbox (see §3.1).

### 1.1 Lift source (recon summary)

`trading-platform/src/research/sandbox/**` (12 files) + `src/research/sandbox-harness/**`:

- **Synchronous IPC by design** — `ipc.ts` `SyncIpcChannel` does NDJSON over the container's raw fds
  with `fs.readSync` + Atomics-sleep, blocking the event loop per round-trip to match the
  **synchronous** 018 `ModuleExecutor` seam (`executeStrategyHook(): readonly StrategyDecision[]`).
- **`docker-driver.ts`** — `DockerDriver.spawnSession(policy, {name, bundleDir, harnessDir})` spawns a
  **long-lived** `docker run -i` (NOT `--rm`), returns the child's raw stdin/stdout/stderr fds;
  `inspectState(name)` reads `.State.OOMKilled`/`ExitCode` to distinguish
  `sandbox_memory_exceeded` vs `sandbox_crashed`; explicit `kill`/`remove`. Security flags: `--network
  none`, `--read-only`, `--tmpfs /tmp:noexec,nosuid`, `--cap-drop ALL`, `--security-opt
  no-new-privileges`, `--pids-limit`, `--memory`=`--memory-swap`, `--cpus`, non-root `--user`, **no
  `-e`** (no secrets), `-v bundleDir:/sandbox/bundle:ro` + `-v harnessDir:/sandbox/harness:ro`, pinned
  image, `node --disallow-code-generation-from-strings /sandbox/harness/entry.mjs`.
- **`sandbox-session.ts`** — one container **per (module, symbol)**; `callHook(hook, ctx)` sends one
  `{t:'hook', seq, hook, snapshot, newBar?}` envelope (`newBar` only on bar transition → structural
  no-lookahead) and blocks for one response; `mapFailure` → terminal codes.
- **`sandbox-executor.ts`** — `SandboxModuleExecutor implements ModuleExecutor` (the 018 seam:
  `executeStrategyHook`/`executeOverlayApply`/`initStrategy`/`disposeStrategy`/`close`); caches a
  `SandboxSession` per `ctx.symbol`; routes returns through the `DecisionRevalidator`.
- **`decision-revalidator.ts`** — re-checks every returned decision against the 017 strategy/overlay
  schemas (`registry.validateRef`); invalid → recorded `decision_schema_invalid`, returns `[]` →
  **decisions never reach risk/exec unless they pass 017**.
- **`routing.ts`** — `createExecutorRouter({sandboxPolicies, …})` routes per module by
  `provenance` (`'trusted'`|`'bundle'`); `createModuleRegistry(input)` extends the 018 trusted
  registry with bundle provenance; **inert-proxy** host modules (`createInertStrategyModule`) expose
  hook properties that THROW, so a bundle hook can never run in-process. `closeAll()` drains
  `errors()` into a surviving array before closing (runner closes in `finally`).
- **`acceptance-gate.ts`** — `validateBundle(bundle, contractContext)`: files exist + entryPoint
  resolves inside `module/`; contractVersion supported; **recompute `computeBundleHash` ==
  descriptor.bundleHash** (integrity); 017 manifest passes `validate({inputKind:'module'})`.
- **`context-serializer.ts`** (host: `StrategyContext → ContextSnapshot` plain data), **`bundle.ts`**
  / **`bundle-hash.ts`**, **`errors.ts`** (019 taxonomy + `SandboxErrorArtifact`), **`redaction.ts`**.
- **Harness** (`sandbox-harness/**`, a build artifact): `entry.mjs` (NDJSON hook loop:
  `{t:'init'}` imports the bundle entry, `{t:'hook'}` rehydrates context + invokes the hook + returns
  decisions), `rehydrate.mjs` (`ContextSnapshot → 017 StrategyContext`, indicators via the copied
  engine), `deny-shims.mjs` (block `child_process` + secret-env, classify errors), and **`_engine/`**
  = the compiled indicator engine copied in by a `build:sandbox-harness` step (the parity invariant).

**The example modules already exist as sandbox bundle fixtures** — `short_after_pump` (strategy,
`hooks:['onBarClose']`) and `early_exit_short_after_pump` (overlay, `hooks:['apply']`,
`interceptionPoint:'post_entry_management'`, `targetStrategyRef:'short_after_pump'`) — each a
`manifest.json` + `module/index.js` that **default-exports a hook factory**. They are liftable as the
backtester's hooks-bundle fixtures (id@version match the trusted modules, so `evidence.moduleVersions`
is unchanged).

**Parity model** — platform `verify_020_equivalence.mjs` runs the **same bundle** trusted vs sandboxed
and asserts `canonicalJson(per-bar decision records)` equality (string equality, Docker-gated). The
full `RunOutcome` is then byte-identical (same downstream sizing/risk/exec/metrics), so
`contentRef(RunOutcome)` matches the 6a goldens.

---

## 2. Goals / non-goals

### Goals (6b-A)

- Lift the platform sandbox subsystem + harness into `apps/backtester/src/engine/sandbox/**` as the
  **untrusted** overlay executor behind the lifted runner's existing `deps.router` seam.
- Route `engine:'overlay'` to **sandbox** when the job carries a `moduleBundle`, else to the **trusted**
  registry (6a) — explicit, by bundle presence.
- Materialize the backtester's inline content-addressed `ModuleBundle` to a temp `bundleDir`; lift the
  017 `acceptance-gate` for hooks bundles.
- Reproduce the harness build (compile `src/engine/indicators/**` → harness `_engine/`) with a
  **drift-guard** (single source of truth — no duplicate indicator impls).
- Prove the sandboxed `RunOutcome` is **byte-identical** to the trusted one — **same goldens**
  (`0be9931c` / `e381659c`), no new ones — via a Docker-gated in-repo equivalence test + an extended
  `verify_018` HTTP gate that submits a bundle.
- Be flag-gated (`enableOverlayEngine`, default off until 6b parity is green) and leave the momentum
  (`eff10116`) + Slice-3 signals paths untouched.
- Fold in the two recorded 6a minors early (§8.1).

### Non-goals (separate follow-up specs)

- **6b-B** — trading-lab drops `baselineOnlyComparison`, consumes the real `comparison`
  (fold the wire `ComparisonSummary{variants[]}` → SDK flat `{baseline,variant,deltas}` via
  `mapPlatformComparison`), and `toBacktesterBundle` carries the real overlay bundle kind.
- **6b-C** — retire `sp4_mock` (flip `BACKTEST_BACKEND` default, collapse the union, DB migration,
  delete the handler branch) **preserving** the `computeParamsHash` byte-compat invariant.
- Moving the sandboxed worker off the main event loop (see §7).
- Merging/deduping the two sandbox subtrees (explicitly forbidden — §3.1).

---

## 3. Architecture

```
apps/backtester/src/engine/          (6a — lifted runner, indicators, validation, sandbox-policy)
apps/backtester/src/engine/sandbox/  NEW (6b-A): docker-driver, ipc, sandbox-session, sandbox-executor,
                                     decision-revalidator, routing, acceptance-gate, context-serializer,
                                     bundle, bundle-hash, errors, redaction, bundle-materialize
apps/backtester/sandbox-harness-overlay/  NEW: entry.mjs, rehydrate.mjs, deny-shims.mjs, _engine/ (built)
apps/backtester/src/determinism/*    REUSED (rng, canonical-json, hash) — shared with the trusted path
@trading/research-contracts/research REUSED (017 types) + (additive) hooks-bundle manifest fields
        │
worker engine:'overlay' branch:
   bundle present → createModuleRegistry({…,sandboxPolicies}) + createExecutorRouter → runOverlayBacktest({registry, router, marketTape})
   no bundle      → buildTrustedRegistry → runOverlayBacktest({registry, marketTape})    (6a, unchanged)
        │ contentRef(runOutcome) == 0be9931c / e381659c  (same goldens)
```

### 3.1 Two sandboxes, deliberately separate (load-bearing invariant)

The Slice-3 sandbox (`src/sandbox/**`) and the 6b overlay sandbox (`src/engine/sandbox/**`) are **two
independent subtrees** and must NOT be merged or deduped:

- Slice-3 `SandboxModuleExecutor` implements `src/runner/module-executor.ts` — **signals**
  (`computeSignals → boolean[]`), **async**, **one-shot** container, used by the **momentum + bundle**
  path.
- 6b `SandboxModuleExecutor` implements the engine `src/engine/module-executor.ts` `ModuleExecutor` +
  `ExecutorRouter` seam — **per-bar hooks** (`executeStrategyHook`/`executeOverlayApply`),
  **synchronous**, **session** container per symbol, used by the **overlay + bundle** path.

The only shared code is `src/determinism/*` and `@trading/research-contracts`. **The spec forbids a
future "dedup" of the two sandboxes** — their seams, IPC models, container lifecycles, and bundle
contracts are different; a shared abstraction would couple the momentum golden path to overlay changes.

---

## 4. Component design

### 4.1 Lift the sandbox subsystem → `src/engine/sandbox/**` (near-verbatim)

Lift the 12 files. Import rewrites: `../../contracts/research/*` → `@trading/research-contracts/research`;
`../backtest/module-executor.js` → `../module-executor.js`; `../backtest/registry.js` →
`../registry.js`; `../backtest/artifacts.js` → `../artifacts.js`; `../validation/*` → `../validation/*`
(6a-lifted); `sandbox-policy` → the 6a-lifted `../sandbox-policy.js`; canonical/rng → `../../determinism/*`.
No logic edits (parity). The `SyncIpcChannel` raw-fd / Atomics approach is lifted as-is (Node 24).

### 4.2 Harness build + drift-guard (single source of truth)

Lift `entry.mjs`/`rehydrate.mjs`/`deny-shims.mjs` into `apps/backtester/sandbox-harness-overlay/`. Add
a build step (`build:sandbox-harness-overlay`) that **compiles `src/engine/indicators/**` (+ the
`rng` + context-rehydrate deps the harness needs) into the harness `_engine/`** — there is exactly ONE
indicator implementation (`src/engine/indicators`), reused by both the in-process engine and the
harness. **Drift-guard** (analogous to the CP1 `CONTRACT_VERSION` lockstep guard): a test asserts the
harness `_engine/` was built from `src/engine/indicators/**` (e.g. compare a content hash / generated
manifest of the built `_engine` against the source set, or assert the build is reproducible and
up-to-date) so a stale or hand-edited `_engine` fails CI. Keep
`--disallow-code-generation-from-strings`, the `:ro` mount, and `deny-shims`.

### 4.3 Bundle model — materialize inline → temp `bundleDir`

The backtester's inline content-addressed `ModuleBundle` (`{manifest, entry, files}`) + `bundle-store`
stay unchanged. The overlay **hooks bundle** carries the **017 `ModuleManifest`** (hooks / kind /
interceptionPoint / targetStrategyRef) — reconciled **additively** with the wire `ModuleManifest`
(`ModuleKind` gains `'overlay'`; the hooks fields are optional on the wire type, populated for hooks
bundles). `validateBundle` (Slice-3, structural, `kind:'strategy'`) is left for the signals path; the
overlay path uses the lifted **`acceptance-gate`** (017-manifest + recompute-`bundleHash` integrity).
At run time a new `bundle-materialize.ts` writes `bundle-store.get(hash)` → a temp dir
(`manifest.json` + `bundle.json` + `module/<files>`), returns the `bundleDir`, and the executor mounts
it `:ro`; the temp dir is cleaned up on `close()`.

### 4.4 Executor selection (worker)

In the worker's `engine:'overlay'` branch (6a):
- **`job.bundleHash` present** → materialize the bundle, build `createModuleRegistry({strategyBundles |
  overlayBundles, riskProfiles:[DEFAULT_RISK], executionProfiles:[DEFAULT_EXEC], sandboxPolicies:[DEFAULT_SANDBOX]})`
  + `createExecutorRouter({sandboxPolicies})`, then `runOverlayBacktest(request, {registry, router,
  marketTape})`. After the run: if `router.errors()` is non-empty on a completed outcome, surface them
  (artifact + terminal code as appropriate); `router.closeAll()` already runs in the runner's `finally`.
- **no bundle** → `buildTrustedRegistry()` (6a, unchanged).

Selection is explicit (bundle presence), matching Slice 3 and the "never silently" requirement.
`resultHash = contentRef(runOutcome)` exactly as 6a.

### 4.5 Sandbox config

Extend `AppConfig.sandbox` / `loadConfig` with the overlay-session knobs the lifted policy needs
(per-call + per-session wall-time, per-message byte caps, the pinned overlay image digest, harness dir
default `../sandbox-harness-overlay`) via `BACKTESTER_SANDBOX_OVERLAY_*` env (default to the lifted
`DEFAULT_SANDBOX` policy values). Keep the Slice-3 `BACKTESTER_SANDBOX_*` block untouched.

---

## 5. Determinism & parity (make-or-break — SAME goldens)

The sandboxed `RunOutcome` of the lifted example bundles MUST be **byte-identical** to the trusted
run ⇒ `contentRef === 0be9931c` (baseline) / `e381659c` (variant). **No new goldens.** Achieved by:
the harness computing indicators via the **identical** `src/engine/indicators` code path (§4.2); the
revalidator passing the same decisions; the runner (sizing/risk/exec/metrics) being the same in-process
code; `rng`/`canonical-json` reused verbatim; the bundle id@version matching the trusted modules.

**Dual-layer proof (Docker-gated → skip-not-fail when no daemon, like Slice 3):**
1. **In-repo equivalence test** (vitest, mirrors platform `verify_020`): run the SAME lifted bundle
   through (a) trusted in-process (6a) and (b) the sandbox executor, assert
   `contentRef(sandboxRunOutcome) === contentRef(trustedRunOutcome)` AND each equals the pinned golden
   (`0be9931c`/`e381659c`). Plus a sandbox run-vs-replay byte-identity check.
2. **`verify_018` HTTP gate extension** (platform `004-sdk-ops-read-surface`): add a bundle-submitting
   case that POSTs `engine:'overlay'` + `moduleBundle` (the hooks bundle) to the running service and
   asserts the service `resultHash === e381659c`. Required green (Docker on the service host) before
   flipping the flag / before 6b-B cutover.

Momentum `eff10116` and the Slice-3 signals path are untouched by 6b-A (no edits to `src/runner/**`,
`src/sandbox/**`, or `src/determinism/**`); the standalone momentum-guardrail test keeps passing.

---

## 6. Error handling

Lift the 019 taxonomy (`sandbox_timeout`, `sandbox_memory_exceeded`, `sandbox_crashed`,
`sandbox_output_overflow`/`_malformed`, `sandbox_forbidden_access`/`_import`, `bundle_load_failed`,
`decision_schema_invalid`). Limit/crash violations map to a clean terminal status + precise
`terminal_code` (mirroring Slice-3's `sandbox_*` → terminal mapping) — **never a service crash**; the
kernel boundary is the guarantee. `DecisionRevalidator` fail-closes invalid decisions to `[]` before
risk/exec. Diagnostics are redacted + byte-bounded. Acceptance-gate rejections → `validation_error`
pre-run.

---

## 7. Blocking synchronous IPC (accepted for 6b-A; documented)

`SyncIpcChannel` blocks the Node event loop per per-bar round-trip (to match the synchronous
`ModuleExecutor` seam — the lifted runner is synchronous). In the backtester service the worker runs
in-process with the HTTP server, so a sandboxed overlay run blocks status/health for its duration.
**Accepted for 6b-A:** worker concurrency is 1 (runs already serialize), runs are bounded by the
per-session wall-time budget, and this preserves byte-parity with no runner-seam changes. Documented as
a known limitation; isolating the sandboxed worker into a `worker_thread`/child process is a **later
slice**, explicitly out of 6b-A scope.

---

## 8. Testing & rollout

- **Preserve:** the four momentum golden tests + the standalone momentum-guardrail + the 6a overlay
  goldens/e2e/gating — all unchanged.
- **New (Docker-gated → skip-not-fail):** acceptance-gate (017 + integrity), session IPC round-trip
  (`SyncIpcChannel` over a real container), bundle materialization (inline → temp `bundleDir`), the
  **equivalence test** (§5.1), sandbox error/limit mapping (timeout/OOM/crash/forbidden), and the
  harness `_engine` **drift-guard** (§4.2). Mirror the structure of `sandbox.test.ts` / `bundle.test.ts`.
- **Cross-repo gate:** the extended `verify_018` HTTP bundle case (§5.2).
- **Flag-gated rollout:** `enableOverlayEngine` stays the gate (default off until 6b parity is green).
  Additive, no big-bang; the momentum + signals paths are untouched. README "Slice 6b-A" section.

### 8.1 Fold in the two 6a minors (early in the slice)

- `apps/backtester/src/jobs/submit.ts`: move the `enableOverlayEngine` gate **before** `validate(body)`
  so a disabled overlay request returns "overlay engine is disabled" rather than `unknown_metric`.
- `apps/backtester/src/engine/data-adapter.ts`: make the `Date.parse` NaN guard throw
  `RunnerError('validation_error')` instead of a bare `Error`.
Both have/get tests; neither touches the momentum path or the goldens.

## 9. Rollout sequence (strangler-fig)

1. Fold the two 6a minors (§8.1).
2. Lift the sandbox subsystem → `src/engine/sandbox/**` (import-rewrite only); typecheck green.
3. Harness build (`_engine` from `src/engine/indicators`) + drift-guard.
4. Bundle materialization + `acceptance-gate` + the additive hooks-manifest reconciliation; lift the
   example bundle fixtures.
5. Wire the worker's overlay→sandbox branch (bundle present); session IPC round-trip green on Docker.
6. **Parity gate (make-or-break):** the in-repo equivalence test → `contentRef === 0be9931c/e381659c`;
   debug any divergence (do not re-freeze goldens). Then extend + run the `verify_018` HTTP bundle gate.
7. Docs + flip guidance. 6b-B / 6b-C are separate specs after this is green.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sandboxed `RunOutcome` not byte-identical to trusted ⇒ golden mismatch (the central risk, as CP3 was) | Identical harness `_engine` (one source of truth + drift-guard), verbatim lift, revalidator parity, same rng/canonical; dual-layer gate; debug-don't-refreeze. |
| Session Docker driver + sync-IPC over raw fds (novel infra) | Lift verbatim (Node 24 raw-fd approach); session IPC round-trip test on a real container; reuse the locked-down run-args profile. |
| Harness `_engine` drifts from `src/engine/indicators` | Single source of truth (compile, don't copy-author) + the drift-guard test. |
| Bundle-model mismatch (inline vs bundleDir) | Materialize-to-tempdir at the executor boundary; bundle-store + wire contract stay inline/content-addressed. |
| Blocking event loop degrades service responsiveness | Accepted/documented for 6b-A; concurrency 1 + session wall-time budget; isolation deferred. |
| Accidental dedup of the two sandboxes couples momentum to overlay | §3.1 invariant + spec note forbidding it. |

## 11. Open items to resolve during implementation

- Exact additive reconciliation of the wire `ModuleManifest`/`ModuleBundle` with the 017 hooks
  manifest (which fields move to the wire type vs stay `/research`-only), and the `acceptance-gate`
  contract-context wiring.
- The precise drift-guard mechanism for `_engine` (content-hash manifest vs reproducible-build check).
- The pinned overlay sandbox image digest (must match whatever base image the harness `_engine` +
  Node 24 needs) and its preflight check.
- Whether the lifted example bundle fixtures need any adjustment to match the backtester's inline
  `ModuleBundle` shape (vs the platform's bundleDir fixtures) — convert at lift time.
