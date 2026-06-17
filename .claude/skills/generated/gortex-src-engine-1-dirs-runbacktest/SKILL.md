---
name: gortex-src-engine-1-dirs-runbacktest
description: "Work in the src/engine +1 dirs · runBacktest area — 69 symbols across 8 files (90% cohesion)"
---

# src/engine +1 dirs · runBacktest

69 symbols | 8 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/artifacts.ts`
- `apps/backtester/src/engine/dataset.ts`
- `apps/backtester/src/engine/module-executor.ts`
- `apps/backtester/src/engine/overlay.ts`
- `apps/backtester/src/engine/registry.ts`
- `apps/backtester/src/engine/run-overlay.ts`
- `apps/backtester/src/engine/runner.ts`
- `packages/research-contracts/src/research/catalogs.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/artifacts.ts` | RunOutcome |
| `apps/backtester/src/engine/dataset.ts` | CandleDataset, bars, fixturesDir, loadCandleDataset, symbol, ... |
| `apps/backtester/src/engine/module-executor.ts` | closeAll |
| `apps/backtester/src/engine/overlay.ts` | registry |
| `apps/backtester/src/engine/registry.ts` | resolveExecutionProfile, ref, resolveStrategy, ref, ref, ... |
| `apps/backtester/src/engine/run-overlay.ts` | request, _engine, deps, OverlayRunDeps, engineRequest, ... |
| `apps/backtester/src/engine/runner.ts` | i, entry, rejected, fillKind, ro, ... |
| `packages/research-contracts/src/research/catalogs.ts` | knownStrategyRefs, platformContractContext |

## Entry Points

- `apps/backtester/src/engine/runner.ts::runBacktest`

## Connected Communities

- **src/engine +1 dirs · simulateTarget** (3 cross-edges)
- **backtester · main** (1 cross-edges)
- **src/engine · computeComparison** (1 cross-edges)
- **src/engine · findRepoRoot** (1 cross-edges)
- **src/engine · declaredMarketKinds** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-71"
smart_context with task: "understand src/engine +1 dirs · runBacktest", format: "gcx"
find_usages with id: "apps/backtester/src/engine/runner.ts::runBacktest", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
