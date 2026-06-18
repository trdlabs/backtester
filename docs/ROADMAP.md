# trading-backtester Roadmap

## Done

- `trading-backtester`
  - Slice 1–5
  - Slice `6a`
  - Slice `6b-A`
  - Feature 1: Client Contract Alignment (`ModuleKind` expanded to `'strategy' | 'overlay'`, `BacktestEngine` exported, `BacktestRunRequest` aligned with research-contracts)
- `trading-lab`
  - backtester adapter introduced
  - `research_platform` path introduced
  - `6b-B` not finished
- `trading-platform` / `trading-mock-platform`
  - further work needed for full production-like historical-data path and final cutover

## Current State

The backtester already supports:

- trusted overlay engine
- sandboxed overlay execution
- async run lifecycle
- `status` / `result` / `artifacts`
- deterministic parity gates

The full user flow

`trading-lab -> trading-backtester -> trading-platform/mock-platform`

is not yet closed end-to-end.

## Feature 1: Client Contract Alignment ✅ DONE

**Goal:** remove the contract gap between `trading-backtester` and `trading-lab`.

### Completed

- `ModuleKind` and `BacktestEngine` include `'overlay'` and are exported
- `ModuleValidateRequest` interface added (`moduleBundle?` + `engine?`) — typed POST /v1/modules/validate contract
- `BacktesterClient.validateModule` accepts `ModuleValidateRequest` instead of `unknown`
- client-parity tests: explicit `Equal<>` guards for `BacktestEngine` and `ModuleKind` parity, compile-time @ts-expect-error guard on `validateModule`

### Done when

`trading-lab` can type-safely submit a real overlay bundle to `trading-backtester`. ✅

## Feature 2: Trading-Lab 6b-B Cutover ✅ DONE

**Goal:** finish the real overlay backtest flow through `trading-backtester`.

### Completed

- `submitOverlayRun` sends `engine: 'overlay'` in `RunSubmitRequest`
- `toSdkComparison()` maps `BtComparisonSummary` (`variants[].metricDeltas`) → `ComparisonSummaryDTO` flat `{baseline, variant, deltas}` records
- `toSdkSummary` detects `comparison` presence and sets `runKind: 'baseline-vs-variant'`
- `BacktesterClientLike.validateModule` typed to `BtModuleValidateRequest` (was `unknown`)
- `runPlatformBacktest` orchestration fully covered: validate → submit → persist → poll → resolve
- 141 test files / 1439 tests green, typecheck clean

### Done when

`trading-lab` can submit a hypothesis to `trading-backtester` and persist a valid backtest result. ✅

## Feature 3: sp4_mock Retirement (6b-C)

**Goal:** remove the legacy path.

### Remaining work

- switch the default backend to `research_platform`
- stop depending on `sp4_mock` for hypothesis backtests
- clean schema defaults, orchestration branches, read models, and tests

### Constraint

Do this only after `6b-B` is fully green.

### Done when

Only the real backtester path remains for hypothesis backtests.

## Feature 4: Historical Data API Hardening

**Goal:** make the real platform data path mandatory and reliable.

### Remaining work

- verify that `trading-platform` and `trading-mock-platform` expose equivalent historical-data contracts
- verify deployment and config for backtester HTTP data source
- run parity between fixture/in-process and platform/mock-platform HTTP paths
- document auth, availability, paging, and drift behavior

### Done when

The backtester reads historical data through the platform contract, not through temporary local modes.

## Feature 5: End-to-End Product Flow

**Goal:** close the full user scenario.

### Scenario

1. `trading-lab` assembles a hypothesis overlay bundle
2. `trading-lab` validates or submits a run to `trading-backtester`
3. `trading-backtester` fetches historical data from `trading-platform` or `trading-mock-platform`
4. `trading-backtester` executes baseline plus sandboxed overlay
5. `trading-lab` receives `status`, `result`, and `artifacts`
6. `trading-lab` persists comparison and evaluation
7. UI / read models expose the outcome to the user

### Remaining work

- integration tests across all three systems
- failure-mode coverage for:
  - validation reject ✅ (inline bundle validation + HTTP error normalization in `validation-reject.test.ts`)
  - sandbox failure ✅ (non-Docker failure modes in `sandbox-failure.test.ts`: `missing_module`, `sandbox_module_error` pre-Docker guard, `runner_failure`)
  - timeout ✅ (`run_deadline_exceeded` covered in `deadline-reaping.test.ts`)
  - missing dataset ✅ (`missing_dataset` covered in `deadline-reaping.test.ts`)
  - queue expiry ✅ (`queue_deadline_exceeded` covered in `deadline-reaping.test.ts`)
  - non-completed terminal runs ✅ (GET /result and GET /artifacts for all terminal states in `terminal-result-api.test.ts`)
- artifact access verification ✅ (artifact manifest + paged artifact endpoint covered in `api.e2e.test.ts`)

### Done when

The “hypothesis to backtest result” user flow works end-to-end.

## Feature 6: Operationalization

**Goal:** make the whole system operable.

### Remaining work

- CI gates for the cross-repo flow
- contract / parity checks across repos
- env/config documentation
- local smoke scripts for the whole stack
- release ordering between repos

### Done when

Cross-repo changes can be rolled out predictably without manual re-debugging of every seam.

## Priority Order

### Phase A

1. `trading-backtester`: client wire follow-up
2. `trading-lab`: finish `6b-B` submit/result flow
3. `trading-lab`: make unit / integration / E2E green

### Phase B

4. `trading-platform` / `trading-mock-platform`: harden the data path
5. run cross-repo E2E
6. switch the default path

### Phase C

7. `6b-C`: retire `sp4_mock`
8. clean legacy code, tests, and docs
9. finish operational docs and CI polish

## Critical Path

The three blockers that matter most are:

1. client-contract gap in `trading-backtester`
2. unfinished `6b-B` in `trading-lab`
3. final cross-repo E2E verification with `trading-platform` / `trading-mock-platform`

## Definition of Done

The system is “working” when:

- `trading-lab` submits hypothesis backtests to `trading-backtester` by default
- `trading-backtester` executes the overlay path with sandboxing
- results and artifacts come back correctly
- historical data comes through the platform or mock-platform contract
- `sp4_mock` is no longer needed
