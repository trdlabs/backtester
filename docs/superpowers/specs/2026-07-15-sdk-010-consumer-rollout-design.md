# SDK 0.10.0 Consumer Rollout Design

## Goal

Roll the published `@trdlabs/sdk@0.10.0` HistoricalClient resilience surface into
the backtester and lab, validate both backtester production data-source paths,
and record the resulting known-good ecosystem set.

## Scope

- Backtester updates all three existing `@trdlabs/sdk` manifests to `^0.10.0`:
  `apps/backtester` dependency, `packages/research-contracts` dependency, and
  `packages/sdk` devDependency. The refreshed lockfile must resolve no `0.9.5`
  copy (`pnpm list -r @trdlabs/sdk`).
- `RowsDataPort` accepts and forwards every `HistoricalClient` transport control:
  `timeoutMs`, `maxAttempts`, `retryBaseMs`, `retryMaxMs`, `maxPages`,
  `maxRows`, `operationDeadlineMs`, and existing `pageLimit`.
- `buildApp` supplies those controls to `RowsDataPort` for both `DATA_SOURCE=real`
  and `DATA_SOURCE=mock`; fixture mode remains unchanged.
- `RowsDataPort` behavioral tests prove transient retry, request timeout,
  operation-deadline enforcement, and page/row fail-closed bounds through the
  published SDK client.
- A separate hermetic integration gate uses the production `buildApp` factory
  branches with independent real/mock HTTP fixtures. It verifies correct base
  URL and token selection and that both paths discover a dataset and read the
  same canonical rows.
- Lab changes its exact dependency pin to `0.10.0` and refreshes its lockfile.
- After both consumer branches are merged and their repository gates pass,
  control-center records a release train entry containing the current
  `origin/main` SHAs and SDK npm version `0.10.0`.

## Non-Goals

- No new SDK API, no direct platform-internal imports, and no modification of
  `@trading-backtester/sdk`.
- No live platform or VPS dependency in CI; the final integration gate is
  hermetic.
- Inspection has confirmed that office and mock-platform do not import
  `@trdlabs/sdk`; neither receives a dependency bump in this slice.

## Design

`RowsDataPortOptions` becomes the adapter-level boundary for all eight
`HistoricalClient` transport controls. Its constructor passes only explicit
values through to `HistoricalClient`, preserving that client's defaults for
direct callers. `buildApp` is the runtime owner of the controls and supplies
the validated `dataApi*` configuration values to both production `RowsDataPort`
instances.

The behavioral tests directly exercise `RowsDataPort` and the real published
SDK transport behavior: a retryable transient status is retried to success, a
hung request is aborted by `timeoutMs`, an operation cannot outlive
`operationDeadlineMs`, and pagination/row limits fail closed. The factory
integration test deliberately runs through `buildApp`, rather than spying on
constructor arguments. It creates one deterministic fixture API for the real
branch and one for the mock branch, provides a finite dataset response and one
page of canonical rows, and asserts that the returned reader rows are
identical while each fixture records its expected URL and bearer token.

The control-center release record is written only after the merged `lab` and
`backtester` main branches have passed their validation commands and the
backtester dual-source integration gate has passed against npm-installed
`@trdlabs/sdk@0.10.0`. Before recording, fetch `origin/main` in every sibling
repository, confirm the two consumer merge commits are contained by their
respective refs, run `pnpm record-release`, verify the record has no null
components, verify `trading-platform-sdk` has its expected SDK git SHA and npm
version `0.10.0`, and compare the recorded lab/backtester SHAs to the verified
merge commits. The record is an integration manifest, not a production
deployment declaration.

## Validation

- Backtester: `pnpm list -r @trdlabs/sdk` has no old version; a clean install
  runtime-imports `SDK_VERSION === '0.10.0'`; targeted RowsDataPort behavioral
  and dual-source factory integration tests, `pnpm typecheck`, and `pnpm test`
  with the required Postgres service where available.
- Lab: exact `0.10.0` lockfile/install, a clean-install runtime import asserting
  `SDK_VERSION === '0.10.0'`, and its primary check gate.
- Cross-repo: both production data-source branches execute the hermetic factory
  integration test through the published package.
- Control-center: fetch all sibling `origin/main` refs, `pnpm record-release`,
  `pnpm releases -- --show <id>` with no null components and matching consumer
  merge SHAs, then normal test and manifest checks.
