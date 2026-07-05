---
name: gortex-backtester-src-persistoverlayartifacts
description: "Work in the backtester/src · persistOverlayArtifacts area — 35 symbols across 3 files (89% cohesion)"
---

# backtester/src · persistOverlayArtifacts

35 symbols | 3 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/artifacts/overlay-store.ts`
- `apps/backtester/src/artifacts/store.ts`
- `apps/backtester/src/runner/run-backtest.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/artifacts/overlay-store.ts` | outcome, persistOverlayArtifacts, store, spec, datasetFingerprint, ... |
| `apps/backtester/src/artifacts/store.ts` | ref, ArtifactStore, payload, raw, write, ... |
| `apps/backtester/src/runner/run-backtest.ts` | BacktestResult |

## Connected Communities

- **src/artifacts** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-17"
smart_context with task: "understand backtester/src · persistOverlayArtifacts", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
