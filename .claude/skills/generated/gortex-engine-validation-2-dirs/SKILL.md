---
name: gortex-engine-validation-2-dirs
description: "Work in the engine/validation +2 dirs area — 129 symbols across 12 files (99% cohesion)"
---

# engine/validation +2 dirs

129 symbols | 12 files | 99% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/validation/assemble.ts`
- `apps/backtester/src/engine/validation/index.ts`
- `apps/backtester/src/engine/validation/normalize.ts`
- `apps/backtester/src/engine/validation/schema-registry.ts`
- `apps/backtester/src/engine/validation/validate-module.ts`
- `apps/backtester/src/engine/validation/validate-promotion.ts`
- `apps/backtester/src/engine/validation/validate-run-request.ts`
- `packages/research-contracts/src/research/catalogs.ts`
- `packages/research-contracts/src/research/module.ts`
- `packages/research-contracts/src/research/schema-assets.ts`
- `packages/research-contracts/src/research/validation-codes.ts`
- `packages/research-contracts/src/run.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/validation/assemble.ts` | path, assemble, message, sorted, b, ... |
| `apps/backtester/src/engine/validation/index.ts` | ValidationInput, input, exhaustive, contractContext, registry, ... |
| `apps/backtester/src/engine/validation/normalize.ts` | base, NormalizedPromotion, normalizeRunRequest, promotion, NormalizedRunRequest, ... |
| `apps/backtester/src/engine/validation/schema-registry.ts` | validate, createSchemaRegistry, SchemaRegistry, name, paramsSchema, ... |
| `apps/backtester/src/engine/validation/validate-module.ts` | key, sampleDecisions, manifest, issues, schemaId, ... |
| `apps/backtester/src/engine/validation/validate-promotion.ts` | PromotionInput, v, p, isStatus, validatePromotion, ... |
| `apps/backtester/src/engine/validation/validate-run-request.ts` | isRef, ownedBySemanticCode, r, path, registry, ... |
| `packages/research-contracts/src/research/catalogs.ts` | ContractContext |
| `packages/research-contracts/src/research/module.ts` | PromotionRequest |
| `packages/research-contracts/src/research/schema-assets.ts` | cause, name, CoreSchemaName, schemaAsset, file |
| `packages/research-contracts/src/research/validation-codes.ts` | ValidationResult |
| `packages/research-contracts/src/run.ts` | ValidationIssue |

## Entry Points

- `apps/backtester/src/engine/validation/validate-run-request.ts::validateRunRequest`
- `apps/backtester/src/engine/validation/validate-module.ts::validateModule`
- `apps/backtester/src/engine/validation/schema-registry.ts::createSchemaRegistry`

## Connected Communities

- **engine/validation +1 dirs · normalizeManifest** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-81"
smart_context with task: "understand engine/validation +2 dirs", format: "gcx"
find_usages with id: "apps/backtester/src/engine/validation/validate-run-request.ts::validateRunRequest", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
