---
name: gortex-src-data-1-dirs-listdatasets
description: "Work in the src/data +1 dirs · listDatasets area — 33 symbols across 3 files (89% cohesion)"
---

# src/data +1 dirs · listDatasets

33 symbols | 3 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/data/data-api-server.ts`
- `apps/backtester/src/data/reader.ts`
- `packages/research-contracts/src/historical.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/data/data-api-server.ts` | dataPort, app, options, maxPageLimit, DataApiServerOptions, ... |
| `apps/backtester/src/data/reader.ts` | raw, rows, datasetFingerprint, listDatasets, file, ... |
| `packages/research-contracts/src/historical.ts` | ReaderRow |

## Entry Points

- `apps/backtester/src/data/data-api-server.ts::createDataApiServer`

## Connected Communities

- **backtester · openDataset** (1 cross-edges)
- **src/data +1 dirs · materialize** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-10"
smart_context with task: "understand src/data +1 dirs · listDatasets", format: "gcx"
find_usages with id: "apps/backtester/src/data/data-api-server.ts::createDataApiServer", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
