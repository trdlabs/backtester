---
name: gortex-src-jobs-1-dirs-submitrun
description: "Work in the src/jobs +1 dirs · submitRun area — 40 symbols across 5 files (83% cohesion)"
---

# src/jobs +1 dirs · submitRun

40 symbols | 5 files | 83% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/jobs/fingerprint.ts`
- `apps/backtester/src/jobs/job-store.ts`
- `apps/backtester/src/jobs/pg-job-store.ts`
- `apps/backtester/src/jobs/submit.ts`
- `packages/client/src/wire.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/jobs/fingerprint.ts` | req, requestFingerprint, normalized |
| `apps/backtester/src/jobs/job-store.ts` | idempotentReplay, toHandle, job, ev, appendEvent, ... |
| `apps/backtester/src/jobs/pg-job-store.ts` | EventDbRow, rowToEvent, r |
| `apps/backtester/src/jobs/submit.ts` | validate, rest, deps, fingerprint, job, ... |
| `packages/client/src/wire.ts` | RunSubmitRequest |

## Entry Points

- `apps/backtester/src/jobs/submit.ts::submitRun`

## Connected Communities

- **src/jobs · rowToJob** (1 cross-edges)
- **src/jobs +1 dirs · processNextQueued** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-91"
smart_context with task: "understand src/jobs +1 dirs · submitRun", format: "gcx"
find_usages with id: "apps/backtester/src/jobs/submit.ts::submitRun", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
