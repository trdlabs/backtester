---
name: gortex-src-runner-runbacktest
description: "Work in the src/runner · runBacktest area — 40 symbols across 2 files (96% cohesion)"
---

# src/runner · runBacktest

40 symbols | 2 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/runner/module-executor.ts`
- `apps/backtester/src/runner/run-backtest.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/runner/module-executor.ts` | out, computeSignals, series, TrustedMomentumExecutor, symbol, ... |
| `apps/backtester/src/runner/run-backtest.ts` | deps, denom, series, candles, symbol, ... |

## Entry Points

- `apps/backtester/src/runner/run-backtest.ts::runBacktest`

## How to Explore

```
get_communities with id: "community-94"
smart_context with task: "understand src/runner · runBacktest", format: "gcx"
find_usages with id: "apps/backtester/src/runner/run-backtest.ts::runBacktest", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
