---
name: gortex-src-engine-1-dirs-kindcoverage
description: "Work in the src/engine +1 dirs · kindCoverage area — 43 symbols across 2 files (94% cohesion)"
---

# src/engine +1 dirs · kindCoverage

43 symbols | 2 files | 94% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/market-tape.ts`
- `packages/research-contracts/src/research/market-tape.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/market-tape.ts` | coveredMinutes, cols, cols, supported, gridTs, ... |
| `packages/research-contracts/src/research/market-tape.ts` | MarketDataKind, KindCoverage, MarketDataCoverageState, MarketDataGap |

## How to Explore

```
get_communities with id: "community-70"
smart_context with task: "understand src/engine +1 dirs · kindCoverage", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
