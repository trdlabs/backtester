---
name: gortex-backtester-test-3-dirs
description: "Work in the backtester/test +3 dirs area — 44 symbols across 8 files (85% cohesion)"
---

# backtester/test +3 dirs

44 symbols | 8 files | 85% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/data-adapter.ts`
- `apps/backtester/src/engine/market-tape.ts`
- `apps/backtester/test/overlay-engine.test.ts`
- `apps/backtester/test/overlay-golden.test.ts`
- `apps/backtester/test/overlay-router.test.ts`
- `packages/research-contracts/src/research/canonical-row.ts`
- `packages/research-contracts/src/research/market-tape.ts`
- `packages/research-contracts/src/run.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/data-adapter.ts` | buildOverlayDataset, tsTo, r, result, batch, ... |
| `apps/backtester/src/engine/market-tape.ts` | symbols, source, rows, anyTaker, detail, ... |
| `apps/backtester/test/overlay-engine.test.ts` | loadRequest, registry, name, overlayDeps, req, ... |
| `apps/backtester/test/overlay-golden.test.ts` | name, loadRequest, overlayDeps, registry, marketTape, ... |
| `apps/backtester/test/overlay-router.test.ts` | req, selFrom |
| `packages/research-contracts/src/research/canonical-row.ts` | CanonicalRowV2 |
| `packages/research-contracts/src/research/market-tape.ts` | TapeBuildResult |
| `packages/research-contracts/src/run.ts` | BacktestRunRequest |

## Entry Points

- `apps/backtester/src/engine/data-adapter.ts::buildOverlayDataset`

## Connected Communities

- **src/engine +1 dirs · buildMarketTape** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-18"
smart_context with task: "understand backtester/test +3 dirs", format: "gcx"
find_usages with id: "apps/backtester/src/engine/data-adapter.ts::buildOverlayDataset", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
