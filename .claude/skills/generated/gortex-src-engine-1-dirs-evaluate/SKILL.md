---
name: gortex-src-engine-1-dirs-evaluate
description: "Work in the src/engine +1 dirs · evaluate area — 33 symbols across 3 files (87% cohesion)"
---

# src/engine +1 dirs · evaluate

33 symbols | 3 files | 87% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/artifacts.ts`
- `apps/backtester/src/engine/risk.ts`
- `packages/research-contracts/src/research/risk-execution.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/artifacts.ts` | RiskClamp |
| `apps/backtester/src/engine/risk.ts` | to, clamps, stop, clampHints, openPositions, ... |
| `packages/research-contracts/src/research/risk-execution.ts` | RiskProfile, Bounds |

## Connected Communities

- **src/engine +1 dirs · buildMarketTape** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-68"
smart_context with task: "understand src/engine +1 dirs · evaluate", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
