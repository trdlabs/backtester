---
name: gortex-src-engine-computemetrics
description: "Work in the src/engine · computeMetrics area — 40 symbols across 2 files (93% cohesion)"
---

# src/engine · computeMetrics

40 symbols | 2 files | 93% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/artifacts.ts`
- `apps/backtester/src/engine/metrics.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/artifacts.ts` | Trade, EquityPoint |
| `apps/backtester/src/engine/metrics.ts` | equity, sharpe, maxWinner, variance, pf, ... |

## How to Explore

```
get_communities with id: "community-72"
smart_context with task: "understand src/engine · computeMetrics", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
