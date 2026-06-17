---
name: gortex-client-src-1-dirs
description: "Work in the client/src +1 dirs area — 50 symbols across 3 files (95% cohesion)"
---

# client/src +1 dirs

50 symbols | 3 files | 95% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/validation/validate-run-request.ts`
- `packages/client/src/client.ts`
- `packages/client/src/wire.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/validation/validate-run-request.ts` | RunRequestInput |
| `packages/client/src/client.ts` | getCapabilities, BacktesterClientOptions, cancelRun, init, message, ... |
| `packages/client/src/wire.ts` | ArtifactPage, RunJobHandle, CapabilityDescriptor, ValidationReport, ArtifactManifest, ... |

## Entry Points

- `packages/client/src/client.ts::BacktesterClient.readArtifact`

## How to Explore

```
get_communities with id: "community-113"
smart_context with task: "understand client/src +1 dirs", format: "gcx"
find_usages with id: "packages/client/src/client.ts::BacktesterClient.readArtifact", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
