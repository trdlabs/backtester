---
name: gortex-src-jobs-1-dirs-processnextqueued
description: "Work in the src/jobs +1 dirs · processNextQueued area — 69 symbols across 5 files (83% cohesion)"
---

# src/jobs +1 dirs · processNextQueued

69 symbols | 5 files | 83% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/jobs/job-store.ts`
- `apps/backtester/src/jobs/overlay-summary.ts`
- `apps/backtester/src/jobs/pg-job-store.ts`
- `apps/backtester/src/jobs/worker.ts`
- `packages/client/src/wire.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/jobs/job-store.ts` | get, job, ok, runId, nowMs, ... |
| `apps/backtester/src/jobs/overlay-summary.ts` | outcome, runId, datasetFingerprint, resultHash, toOverlaySummary, ... |
| `apps/backtester/src/jobs/pg-job-store.ts` | runId, from, patch, entry, to, ... |
| `apps/backtester/src/jobs/worker.ts` | from, processed, drainQueue, deps, periodMs, ... |
| `packages/client/src/wire.ts` | RunPeriod, ArtifactReference |

## Entry Points

- `apps/backtester/src/jobs/worker.ts::processNextQueued`
- `apps/backtester/src/jobs/job-store.ts::InMemoryJobStore.insertOrGet`

## Connected Communities

- **src/jobs +1 dirs · transition** (2 cross-edges)
- **src/jobs +1 dirs · publishCompletion** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-92"
smart_context with task: "understand src/jobs +1 dirs · processNextQueued", format: "gcx"
find_usages with id: "apps/backtester/src/jobs/worker.ts::processNextQueued", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
