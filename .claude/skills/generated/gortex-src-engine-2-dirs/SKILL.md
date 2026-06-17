---
name: gortex-src-engine-2-dirs
description: "Work in the src/engine +2 dirs area — 159 symbols across 10 files (90% cohesion)"
---

# src/engine +2 dirs

159 symbols | 10 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/context.ts`
- `apps/backtester/src/engine/dataset.ts`
- `apps/backtester/src/engine/indicators/engine.ts`
- `apps/backtester/src/engine/module-executor.ts`
- `apps/backtester/src/engine/overlay.ts`
- `apps/backtester/src/engine/portfolio.ts`
- `apps/backtester/src/engine/runner.ts`
- `packages/research-contracts/src/research/context.ts`
- `packages/research-contracts/src/research/decision.ts`
- `packages/research-contracts/src/research/module.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/context.ts` | build, obj, barIndex, propKey, T, ... |
| `apps/backtester/src/engine/dataset.ts` | barIndex, indicatorApiFor, engine |
| `apps/backtester/src/engine/indicators/engine.ts` | barIndex, accessorAt |
| `apps/backtester/src/engine/module-executor.ts` | forOverlay, module, forStrategy, ctx, InProcessTrustedModuleExecutor, ... |
| `apps/backtester/src/engine/overlay.ts` | branch, overlayRef, overlay, overlays, OverlayComposer, ... |
| `apps/backtester/src/engine/portfolio.ts` | equityAt, _position, exitPrice, constructor, exitPrice, ... |
| `apps/backtester/src/engine/runner.ts` | barIndex, order, intent, expired, riskDecision, ... |
| `packages/research-contracts/src/research/context.ts` | IndicatorApi, StrategyContext |
| `packages/research-contracts/src/research/decision.ts` | OverlayDecision, StrategyDecision |
| `packages/research-contracts/src/research/module.ts` | HypothesisOverlayModule, StrategyModule |

## Entry Points

- `apps/backtester/src/engine/runner.ts::runSymbol`

## Connected Communities

- **src/engine +1 dirs · evaluate** (6 cross-edges)
- **src/engine · settlePending** (2 cross-edges)
- **src/engine · buildTrade** (1 cross-edges)
- **src/engine +1 dirs · smaAsOf** (1 cross-edges)
- **src/engine +1 dirs · pointInTimeMarketApi** (1 cross-edges)
- **src/engine +1 dirs · runBacktest** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-72"
smart_context with task: "understand src/engine +2 dirs", format: "gcx"
find_usages with id: "apps/backtester/src/engine/runner.ts::runSymbol", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
