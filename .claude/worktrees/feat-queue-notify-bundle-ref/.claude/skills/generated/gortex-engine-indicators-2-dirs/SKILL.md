---
name: gortex-engine-indicators-2-dirs
description: "Work in the engine/indicators +2 dirs area — 52 symbols across 5 files (91% cohesion)"
---

# engine/indicators +2 dirs

52 symbols | 5 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/indicators/backend/adapter.ts`
- `apps/backtester/src/engine/indicators/catalog.ts`
- `apps/backtester/src/engine/indicators/engine.ts`
- `apps/backtester/src/engine/indicators/key.ts`
- `packages/research-contracts/src/research/indicators.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/indicators/backend/adapter.ts` | IndicatorBackendAdapter |
| `apps/backtester/src/engine/indicators/catalog.ts` | name, catalog, findDefinition |
| `apps/backtester/src/engine/indicators/engine.ts` | candles, value, i, args, source, ... |
| `apps/backtester/src/engine/indicators/key.ts` | parts, canonicalKey, name, params, source |
| `packages/research-contracts/src/research/indicators.ts` | IndicatorRequest |

## Entry Points

- `apps/backtester/src/engine/indicators/engine.ts::createIndicatorEngine`

## Connected Communities

- **engine/indicators +1 dirs · validateIndicatorRequest** (3 cross-edges)

## How to Explore

```
get_communities with id: "community-45"
smart_context with task: "understand engine/indicators +2 dirs", format: "gcx"
find_usages with id: "apps/backtester/src/engine/indicators/engine.ts::createIndicatorEngine", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
