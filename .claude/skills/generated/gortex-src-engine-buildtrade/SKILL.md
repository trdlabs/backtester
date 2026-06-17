---
name: gortex-src-engine-buildtrade
description: "Work in the src/engine · buildTrade area — 45 symbols across 2 files (84% cohesion)"
---

# src/engine · buildTrade

45 symbols | 2 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/artifacts.ts`
- `apps/backtester/src/engine/portfolio.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/artifacts.ts` | CloseReason |
| `apps/backtester/src/engine/portfolio.ts` | pos, exitFee, exitFillPrice, entryFeeClosed, isProtection, ... |

## Connected Communities

- **src/engine +2 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-65"
smart_context with task: "understand src/engine · buildTrade", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
