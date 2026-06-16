# trading-backtester

Standalone research-backtesting service for the `trading-*` ecosystem. It accepts strategy/hypothesis
modules from `trading-lab`, runs deterministic research backtests, stores its own async job lifecycle
and result artifacts, and serves status/result/artifacts over HTTP. It holds **no exchange credentials**
and fetches historical data through a platform-owned data port (so real `trading-platform` and a future
`trading-mock-platform` are interchangeable).

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full MVP architecture and decisions.

## Status

**Slice 1 (thin spine)** — HTTP API + async lifecycle + idempotency + content-addressed artifact store
+ deterministic `result_hash`, on a small fixture. Minimal momentum runner behind the `runBacktest`
seam (not a full engine lift), in-process fixture data port, trusted in-process executor.

**Slice 2 (durable store + outbox/webhook)** — Postgres `JobStore` (`PgJobStore`) behaviorally
equivalent to the in-memory one: atomic conditional `transition` (terminal statuses immutable),
concurrency-safe `claimNextQueued` (`FOR UPDATE SKIP LOCKED`), `resumeToken` idempotency that survives
process restart. Completion outbox + best-effort webhook delivery with retry. The full behavioral suite
runs against **both** stores (parametrized); the golden `result_hash` is identical across backends.

Deferred (see ARCHITECTURE §11): Docker sandbox for untrusted bundles (Slice 3), networked Research
Historical Data API (Slice 4), trading-lab cutover (Slice 5).

## Layout

```
packages/research-contracts   # @trading/research-contracts — shared 017/022 types + historical data port (parity anchor)
apps/backtester               # the service
  src/determinism/            # canonical-json + seeded rng (lifted verbatim from platform 018) + content hashing
  src/runner/                 # minimal deterministic momentum runner (runBacktest seam)
  src/data/                   # BacktesterDataPort + in-process fixture reader + materialize
  src/jobs/                   # 8-state lifecycle, JobStore (in-memory + Postgres), fingerprint, submit, worker, completion/outbox
  src/artifacts/              # content-addressed artifact store + manifest
  src/db/                     # pg pool + forward-only migration runner
  src/api/                    # Fastify HTTP API
  migrations/                 # 0001_init.sql (backtest_job + backtest_job_event)
  fixtures/candles/           # smoke dataset
  test/                       # determinism, idempotency, e2e, restart, completion, concurrent-claim (parametrized over stores)
```

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm start          # serves on 127.0.0.1:8080 (BACKTESTER_AUTH_TOKEN, default "dev-token")
```

### Postgres (Slice 2)

Set `DATABASE_URL` to run the service on `PgJobStore`; without it the service uses the in-memory store.
To run the suite against Postgres as well (otherwise the pg-parametrized tests **skip**, they do not fail):

```bash
docker run -d --name bt-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=backtester_test \
  -p 55432:5432 postgres:16-alpine
BACKTESTER_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/backtester_test pnpm test
```

Each test run isolates itself in a throwaway schema (created + migrated, dropped on teardown).

## HTTP API (v1, bearer auth)

| Method & path | Purpose |
|---|---|
| `GET  /v1/capabilities` | contract version, supported metrics/modes |
| `GET  /v1/datasets` | list available datasets |
| `POST /v1/modules/validate` | pre-submit validation (never executes) |
| `POST /v1/runs` | submit a run → `202` + `RunJobHandle` (idempotent on `resumeToken`) |
| `GET  /v1/runs/:runId/status` | lifecycle status + timeline |
| `GET  /v1/runs/:runId/result` | compact `RunResultSummary` (metrics, evidence, `resultHash`) |
| `GET  /v1/runs/:runId/artifacts` | artifact manifest |
| `GET  /v1/runs/:runId/artifacts/:artifactId` | paged artifact body |
| `POST /v1/runs/:runId/cancel` | cancel a non-terminal run |

### Example

```bash
curl -sS -XPOST localhost:8080/v1/runs -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' -d '{
    "mode":"research","moduleRef":{"id":"smoke","version":"1.0.0"},
    "datasetRef":"smoke-btc-1m","symbols":["BTCUSDT"],"timeframe":"1m",
    "period":{"from":"2023-11-14T00:00:00.000Z","to":"2023-11-15T00:00:00.000Z"},
    "seed":42,"metrics":[]
  }'
```
