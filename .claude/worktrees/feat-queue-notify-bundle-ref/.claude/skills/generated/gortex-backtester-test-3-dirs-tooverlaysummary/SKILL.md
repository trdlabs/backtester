---
name: gortex-backtester-test-3-dirs-tooverlaysummary
description: "Work in the backtester/test +3 dirs · toOverlaySummary area — 37 symbols across 7 files (85% cohesion)"
---

# backtester/test +3 dirs · toOverlaySummary

37 symbols | 7 files | 85% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/jobs/overlay-summary.ts`
- `apps/backtester/src/sandbox/bundle-store.ts`
- `apps/backtester/src/sandbox/bundle.ts`
- `apps/backtester/test/overlay-sandbox-acceptance.test.ts`
- `apps/backtester/test/overlay-sandbox-materialize.test.ts`
- `apps/backtester/test/sandbox.test.ts`
- `packages/client/src/wire.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/jobs/overlay-summary.ts` | artifactRefs, toOverlaySummary, datasetFingerprint, evidence, bundleHash, ... |
| `apps/backtester/src/sandbox/bundle-store.ts` | hash, hexOf, FileBundleStore, hash, baseDir, ... |
| `apps/backtester/src/sandbox/bundle.ts` | bundleHash, bundle |
| `apps/backtester/test/overlay-sandbox-acceptance.test.ts` | name, loadInlineBundle |
| `apps/backtester/test/overlay-sandbox-materialize.test.ts` | loadInlineBundle, name |
| `apps/backtester/test/sandbox.test.ts` | source, bundle |
| `packages/client/src/wire.ts` | ContentHash, ModuleBundle, ArtifactReference |

## How to Explore

```
get_communities with id: "community-125"
smart_context with task: "understand backtester/test +3 dirs · toOverlaySummary", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
