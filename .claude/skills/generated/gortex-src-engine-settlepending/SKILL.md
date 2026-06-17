---
name: gortex-src-engine-settlepending
description: "Work in the src/engine · settlePending area — 73 symbols across 3 files (90% cohesion)"
---

# src/engine · settlePending

73 symbols | 3 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/execution.ts`
- `apps/backtester/src/engine/portfolio.ts`
- `apps/backtester/src/engine/runner.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/execution.ts` | sizingPct, size, fee, size, side, ... |
| `apps/backtester/src/engine/portfolio.ts` | OpenFill, newEntry, fill, order, _mode, ... |
| `apps/backtester/src/engine/runner.ts` | isPartial, runProtectionCheck, barIndex, acc, pending, ... |

## Connected Communities

- **src/engine · buildTrade** (4 cross-edges)
- **src/engine · detectProtection** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-74"
smart_context with task: "understand src/engine · settlePending", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
