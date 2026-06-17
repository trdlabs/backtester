---
name: gortex-src-db-4-dirs
description: "Work in the src/db +4 dirs area — 33 symbols across 5 files (91% cohesion)"
---

# src/db +4 dirs

33 symbols | 5 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/db/migrate.ts`
- `apps/backtester/src/engine/indicators/engine.ts`
- `apps/backtester/src/jobs/pg-job-store.ts`
- `apps/backtester/test/store-factories.ts`
- `packages/research-contracts/src/research/indicators.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/db/migrate.ts` | file, ran, client, appliedRows, sql, ... |
| `apps/backtester/src/engine/indicators/engine.ts` | request, query |
| `apps/backtester/src/jobs/pg-job-store.ts` | appendEvent, ev |
| `apps/backtester/test/store-factories.ts` | schema, admin, createPgSchema, migPool, admin, ... |
| `packages/research-contracts/src/research/indicators.ts` | IndicatorValue |

## Entry Points

- `apps/backtester/src/db/migrate.ts::migrate`
- `apps/backtester/test/store-factories.ts::createPgSchema`
- `apps/backtester/test/store-factories.ts::STORE_FACTORIES.create@94`

## How to Explore

```
get_communities with id: "community-109"
smart_context with task: "understand src/db +4 dirs", format: "gcx"
find_usages with id: "apps/backtester/src/db/migrate.ts::migrate", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
