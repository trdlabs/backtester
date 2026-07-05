---
name: gortex-backtester-test-3-dirs-buildoverlaydataset
description: "Work in the backtester/test +3 dirs · buildOverlayDataset area — 55 symbols across 11 files (85% cohesion)"
---

# backtester/test +3 dirs · buildOverlayDataset

55 symbols | 11 files | 85% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/data-adapter.ts`
- `apps/backtester/src/engine/market-tape.ts`
- `apps/backtester/src/engine/module-executor.ts`
- `apps/backtester/test/overlay-engine.test.ts`
- `apps/backtester/test/overlay-golden.test.ts`
- `apps/backtester/test/overlay-router.test.ts`
- `apps/backtester/test/overlay-sandbox-equivalence.test.ts`
- `apps/backtester/test/overlay-sandbox-session.test.ts`
- `packages/research-contracts/src/research/canonical-row.ts`
- `packages/research-contracts/src/research/market-tape.ts`
- `packages/research-contracts/src/run.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/data-adapter.ts` | batch, toCanonicalRowV2, tsTo, reader, result, ... |
| `apps/backtester/src/engine/market-tape.ts` | bucket, datasetRef, reject, anyOi, source, ... |
| `apps/backtester/src/engine/module-executor.ts` | close, createTrustedRouter, ExecutorRouter, exec, executor |
| `apps/backtester/test/overlay-engine.test.ts` | name, req, registry, marketTape, overlayDeps, ... |
| `apps/backtester/test/overlay-golden.test.ts` | registry, loadRequest, overlayDeps, name, req, ... |
| `apps/backtester/test/overlay-router.test.ts` | req, selFrom |
| `apps/backtester/test/overlay-sandbox-equivalence.test.ts` | selFrom, loadRequest, req, name |
| `apps/backtester/test/overlay-sandbox-session.test.ts` | loadRequest, name |
| `packages/research-contracts/src/research/canonical-row.ts` | CanonicalRowV2 |
| `packages/research-contracts/src/research/market-tape.ts` | TapeBuildResult |
| `packages/research-contracts/src/run.ts` | BacktestRunRequest |

## Entry Points

- `apps/backtester/src/engine/data-adapter.ts::buildOverlayDataset`

## Connected Communities

- **src/engine +1 dirs · buildMarketTape** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-29"
smart_context with task: "understand backtester/test +3 dirs · buildOverlayDataset", format: "gcx"
find_usages with id: "apps/backtester/src/engine/data-adapter.ts::buildOverlayDataset", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
