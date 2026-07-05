---
name: gortex-backtester-src-buildapp
description: "Work in the backtester/src · buildApp area — 43 symbols across 3 files (90% cohesion)"
---

# backtester/src · buildApp

43 symbols | 3 files | 90% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/app.ts`
- `apps/backtester/src/config.ts`
- `apps/backtester/src/index.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/app.ts` | sandbox, workerDeps, artifactStore, drain, kick, ... |
| `apps/backtester/src/config.ts` | loadConfig, AppConfig, overlayPolicy, env, overlayImage |
| `apps/backtester/src/index.ts` | config, main, shutdown, addr, app, ... |

## Entry Points

- `apps/backtester/src/index.ts::main`
- `apps/backtester/src/app.ts::buildApp`
- `apps/backtester/src/config.ts::loadConfig`

## How to Explore

```
get_communities with id: "community-15"
smart_context with task: "understand backtester/src · buildApp", format: "gcx"
find_usages with id: "apps/backtester/src/index.ts::main", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
