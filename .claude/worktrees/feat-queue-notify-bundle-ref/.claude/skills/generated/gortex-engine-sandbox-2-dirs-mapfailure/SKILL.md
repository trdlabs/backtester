---
name: gortex-engine-sandbox-2-dirs-mapfailure
description: "Work in the engine/sandbox +2 dirs · mapFailure area — 133 symbols across 11 files (91% cohesion)"
---

# engine/sandbox +2 dirs · mapFailure

133 symbols | 11 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `apps/backtester/src/engine/examples/early-exit-short-after-pump.overlay.ts`
- `apps/backtester/src/engine/examples/short-after-pump.strategy.ts`
- `apps/backtester/src/engine/sandbox/context-serializer.ts`
- `apps/backtester/src/engine/sandbox/docker-driver.ts`
- `apps/backtester/src/engine/sandbox/errors.ts`
- `apps/backtester/src/engine/sandbox/ipc.ts`
- `apps/backtester/src/engine/sandbox/routing.ts`
- `apps/backtester/src/engine/sandbox/sandbox-executor.ts`
- `apps/backtester/src/engine/sandbox/sandbox-session.ts`
- `packages/research-contracts/src/research/context.ts`
- `packages/research-contracts/src/research/module.ts`

## Key Files

| File | Symbols |
|------|---------|
| `apps/backtester/src/engine/examples/early-exit-short-after-pump.overlay.ts` | rsi, position, maxAdverseBars, adverse, suffix, ... |
| `apps/backtester/src/engine/examples/short-after-pump.strategy.ts` | windowMin, shortAfterPump.onBarClose, atr, bollinger, changePct, ... |
| `apps/backtester/src/engine/sandbox/context-serializer.ts` | plainBar, bar |
| `apps/backtester/src/engine/sandbox/docker-driver.ts` | kill, r, remove, name, DockerDriver, ... |
| `apps/backtester/src/engine/sandbox/errors.ts` | SandboxValidationCode |
| `apps/backtester/src/engine/sandbox/ipc.ts` | stderrText, send, Request, req |
| `apps/backtester/src/engine/sandbox/routing.ts` | ExecutorRouter |
| `apps/backtester/src/engine/sandbox/sandbox-executor.ts` | sessions, executeStrategyHook, ctx, executeOverlayApply, opened, ... |
| `apps/backtester/src/engine/sandbox/sandbox-session.ts` | h, code, error, hook, descriptor, ... |
| `packages/research-contracts/src/research/context.ts` | StrategyContext, Bar |
| `packages/research-contracts/src/research/module.ts` | StrategyModule |

## Entry Points

- `apps/backtester/src/engine/examples/short-after-pump.strategy.ts::shortAfterPump.onBarClose@45`
- `apps/backtester/src/engine/examples/early-exit-short-after-pump.overlay.ts::earlyExitShortAfterPump.apply@43`
- `apps/backtester/src/engine/sandbox/sandbox-executor.ts::SandboxModuleExecutor.initStrategy`

## Connected Communities

- **engine/sandbox · revalidate** (2 cross-edges)
- **engine/sandbox · receive** (2 cross-edges)
- **engine/sandbox · boundedRedactedDetail** (1 cross-edges)
- **engine/sandbox · sessionContainerName** (1 cross-edges)
- **src/engine · spawnSession** (1 cross-edges)
- **engine/sandbox +1 dirs · serializeContext** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-106"
smart_context with task: "understand engine/sandbox +2 dirs · mapFailure", format: "gcx"
find_usages with id: "apps/backtester/src/engine/examples/short-after-pump.strategy.ts::shortAfterPump.onBarClose@45", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
