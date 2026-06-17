---
name: gortex-src-engine-1-dirs-buildmarkettape
description: "Work in the src/engine +1 dirs · buildMarketTape area — 40 symbols across 3 files (92% cohesion)"
---

# src/engine +1 dirs · buildMarketTape

40 symbols | 3 files | 92% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/market-tape.ts`
- `apps/backtester/src/engine/risk.ts`
- `packages/research-contracts/src/research/decision.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/market-tape.ts` | snapshots, key, frozenBars, indexByMinute, asRecord, ... |
| `apps/backtester/src/engine/risk.ts` | AddPositionContext, currentPct, allowedPct, requestedPct, limits, ... |
| `packages/research-contracts/src/research/decision.ts` | AddToPositionDecision |

## Entry Points

- `apps/backtester/src/engine/market-tape.ts::buildMarketTape`

## Connected Communities

- **src/engine +1 dirs · materialize** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-69"
smart_context with task: "understand src/engine +1 dirs · buildMarketTape", format: "gcx"
find_usages with id: "apps/backtester/src/engine/market-tape.ts::buildMarketTape", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
