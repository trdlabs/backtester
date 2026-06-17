---
name: gortex-src-jobs-rowtojob
description: "Work in the src/jobs · rowToJob area — 40 symbols across 1 files (91% cohesion)"
---

# src/jobs · rowToJob

40 symbols | 1 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/jobs/pg-job-store.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/jobs/pg-job-store.ts` | reapDeadlines, r, filter, clause, values, ... |

## Entry Points

- `apps/backtester/src/jobs/pg-job-store.ts::PgJobStore.list`

## How to Explore

```
get_communities with id: "community-89"
smart_context with task: "understand src/jobs · rowToJob", format: "gcx"
find_usages with id: "apps/backtester/src/jobs/pg-job-store.ts::PgJobStore.list", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
