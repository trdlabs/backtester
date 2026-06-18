# Operations — trading-* research stack

How to verify, release, and roll out changes across `trading-backtester`, `trading-lab`,
`trading-platform`, and `trading-mock-platform` without re-debugging every seam.

## Repo roles

| Repo | Role in the flow |
|------|------------------|
| `trading-platform` | Canonical research engine, historical data writer, contract gates (`gates:017`…`gates:037`) |
| `trading-mock-platform` | Credential-free ops-read + historical replay for local/demo stacks |
| `trading-backtester` | Async research job service; HTTP client boundary for `trading-lab` |
| `trading-lab` | Hypothesis orchestration; submits runs via `@trading-backtester/client` |

## Release ordering

When a change spans repositories, land in this order:

1. **`trading-platform`** — contract / schema / historical API changes first (`npm run check:035` or your slice gate).
2. **`trading-mock-platform`** — refresh vendored SDK + snapshot parity if platform contracts moved (`pnpm check:ci`).
3. **`trading-backtester`**
   - `packages/research-contracts` (if types changed)
   - `packages/client` (rebuild dist; trading-lab depends on `file:../trading-backtester/packages/client`)
   - service + tests (`pnpm check`)
4. **`trading-lab`** — adapter / handler wiring last (`pnpm check`); bump client path dep only after backtester client dist is committed.

Tag or note the **client dist SHA** in the backtester PR when wire types change — lab CI does not rebuild the client for you.

## Per-repo CI gates (default PR / push)

| Repo | Command | What it proves |
|------|---------|----------------|
| `trading-backtester` | `pnpm check` | `tsc` + full Vitest suite (in-memory + Pg parametrized where applicable) |
| `trading-lab` | `pnpm check` | `tsc` + Vitest (integration tests skip without env) |
| `trading-mock-platform` | `pnpm check:ci` | typecheck, contract isolation, tests, secret/dep guards |
| `trading-platform` | `npm run check:035` (or slice gate) | Research + historical contract gates |

### Cross-repo parity (local or pre-release)

| Gate | Where | Command |
|------|-------|---------|
| Mock historical parity | `trading-backtester` | `pnpm vitest run apps/backtester/test/mock-platform-parity.test.ts` |
| Platform overlay `result_hash` | `trading-platform` | `VERIFY_018_TARGET=http BACKTESTER_URL=… npm run gates:018` (HTTP mode against live service) |
| Lab → backtester → mock (3-system) | `trading-lab` | `make cross-repo-e2e MODE=demo` (requires demo stack) |

## Environment variables (cross-repo seams)

### trading-backtester

| Variable | Purpose |
|----------|---------|
| `BACKTESTER_DATA_SOURCE` | `fixture` (default dev) or `mock` / `http` for networked historical API |
| `BACKTESTER_MOCK_PLATFORM_URL` | Base URL when `DATA_SOURCE=mock` |
| `BACKTESTER_MOCK_PLATFORM_TOKEN` | Bearer for mock-platform ops/historical routes |
| `BACKTESTER_AUTH_TOKEN` | Bearer for lab → backtester HTTP API |
| `BACKTESTER_ENABLE_OVERLAY_ENGINE` | `true` to allow `engine: overlay` submissions |

### trading-lab (demo overlay)

| Variable | Purpose |
|----------|---------|
| `TRADING_PLATFORM_INTEGRATION` | `backtester` in demo (not `mock` / `sp4_mock`) |
| `BACKTESTER_API_URL` | In compose: `http://backtester:8080`; on host: `http://127.0.0.1:${BACKTESTER_HOST_PORT}` |
| `BACKTESTER_API_TOKEN` | Same as `BACKTESTER_AUTH_TOKEN` in backtester |
| `LAB_OPS_READ_URL` / `LAB_OPS_READ_TOKEN` | Mock-platform ops-read for bot results |
| `TRADING_LAB_CALLBACK_PUBLIC_URL` | Public ingress base URL for backtester completion webhook (demo: `http://ingress:3000`) |
| `TRADING_LAB_CALLBACK_TOKEN` | Bearer/query token for `POST /callbacks/backtest-completed` |
| `BACKTESTER_HOST_PORT` | Host-published backtester port in demo (`8081` default; office web stays on `8080`) |
| `RUN_CROSS_REPO_E2E` | Set `true` to enable `cross-repo-e2e.integration.test.ts` |

See `trading-lab/README.md` and `.env.demo.example` for the full demo matrix.

## Local verification workflow

### 1. Unit gates (no Docker)

```bash
# backtester
cd trading-backtester && pnpm check

# lab (sibling checkout)
cd trading-lab && pnpm check
```

### 2. Demo stack smoke (Docker)

```bash
cd trading-lab
cp .env.demo.example .env.demo   # set TRADING_*_PATH siblings
make demo                        # foreground; or -d for detached
make smoke MODE=demo             # health + mock-platform + backtester probes
```

### 3. Cross-repo E2E (opt-in, demo stack must be up)

```bash
cd trading-lab
make cross-repo-e2e MODE=demo
```

Runs `cross-repo-e2e.integration.test.ts`: dataset discovery uses mock-platform refs,
submit/poll completes, `hypothesis.build` reaches `evaluated`.

### 4. Full research cycle (slow)

```bash
make e2e MODE=demo   # strategy onboard → research.run_cycle.completed
```

## Failure triage

| Symptom | Likely seam |
|---------|-------------|
| `smoke-btc-1m` datasets in lab | Backtester still on `fixture` data source — check `BACKTESTER_DATA_SOURCE=mock` |
| `result_hash` mismatch vs platform | Run platform `verify_018_*` in HTTP mode; compare overlay engine flag + bundle |
| 401 on backtester | Token mismatch: `BACKTESTER_AUTH_TOKEN` ↔ `BACKTESTER_API_TOKEN` |
| Cross-repo test skips | Export `RUN_CROSS_REPO_E2E=true` and reachable `BACKTESTER_API_URL` |

## Definition of operable

Feature 6 is satisfied when:

- Each repo has a documented `check` entrypoint and CI runs it on PR/push.
- Cross-repo parity gates are named, scripted, and listed above.
- Demo stack smoke + cross-repo E2E are one-command (`make smoke`, `make cross-repo-e2e`).
- Release ordering is explicit so agents and humans land contract changes before consumers.
