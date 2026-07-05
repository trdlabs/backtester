# Design: market-tape runtime API in `getAuthoringDoc()`

**Date:** 2026-06-29
**Status:** approved (brainstorming)
**Scope:** single-file SDK doc enrichment + test + version bump + SDK release

## Problem

The F2b builder-proof loop in trading-platform has an LLM author a strategy bundle (via
`@trading-backtester/sdk/builder`), runs it in paper, and compares it against a curated `long_oi`
baseline. A real run (gpt-5.5) produced a strategy that **never opens a position**.

Root cause, confirmed by reading the generated bundle: `getAuthoringDoc()` documents
`ctx.data.closedCandles()` but does **not** document the runtime market-tape API (`ctx.market`).
The LLM correctly declared `dataNeeds.openInterest / liquidations: true`, but **guessed** how to
read the values — and guessed wrong:

| Data | Real API (method) | LLM emitted (nonexistent field) | Effect |
|------|-------------------|---------------------------------|--------|
| OI | `ctx.market.oiWindow(n)` / `ctx.market.oiAsOf()` | `ctx.market.openInterest`, `.oi` | `undefined` → OI condition always false |
| Liquidations | `ctx.market.liqAsOf()` | `ctx.market.liquidations.long` | `undefined` → liq condition always false |

The strategy entry requires `... && oiOk && liqOk`; both are permanently false, so the strategy is
blind to OI/liq and never enters.

A second, subtler trap (covered by this design): `fundingAsOf` / `takerAsOf` return a **3-state
reading object**, not `Point | undefined` like `oiAsOf` / `liqAsOf` — so the access pattern differs
(branch on `.state`, then read `.point`).

## Source of truth

Canonical types live in the platform kernel and are re-exported through the SDK:
`@trading-platform/sdk/research-contract` → `packages/research-contracts/src/research/market-tape.ts`
→ `packages/sdk/src/contracts/authoring.ts`.

Runtime implementation: `apps/backtester/src/engine/market-access.ts::pointInTimeMarketApi`.
Behavior pinned by `apps/backtester/test/market-access.test.ts`.

Verified shapes (1:1 against `market-tape.d.ts`):

```
interface OiPoint     { readonly ts: number; readonly oiTotalUsd: number }
interface LiqPoint    { readonly ts: number; readonly longUsd: number; readonly shortUsd: number }
interface FundingPoint{ readonly ts: number; readonly fundingRate: number }
interface TakerPoint  { readonly ts: number; readonly buyUsd: number; readonly sellUsd: number }

type FundingReading = { state:'present'; point:FundingPoint }
                    | { state:'stale';   point:FundingPoint }
                    | { state:'missing' }
type TakerReading   = { state:'present'; point:TakerPoint }
                    | { state:'stale' }
                    | { state:'missing' }

interface PointInTimeMarketApi {
  oiAsOf():  OiPoint  | undefined
  liqAsOf(): LiqPoint | undefined
  oiWindow(lookback: number):  readonly (OiPoint  | undefined)[]
  liqWindow(lookback: number): readonly (LiqPoint | undefined)[]
  fundingAsOf?():  FundingReading
  fundingWindow?(lookback: number): readonly (FundingPoint | undefined)[]
  takerAsOf?():    TakerReading
  takerWindow?(lookback: number):   readonly (TakerPoint  | undefined)[]
}
```

Gap / coverage semantics (from the kernel doc-comments and `market-access.test.ts`):

- `oiAsOf()` / `liqAsOf()` → `undefined` on a gap (uncovered minute) or when the kind is absent
  from the tape. No carry-forward.
- `liqAsOf()` → `{ longUsd:0, shortUsd:0 }` on a **covered** minute with no liquidations. This is a
  real "no liquidations" point, NOT missing. `undefined` ≠ `{0,0}`.
- `oiWindow(n)` / `liqWindow(n)` end **at `t` inclusive** (index `len-1` = minute `t`); each slot is
  a point or `undefined` (gap, no carry-forward); length = `min(lookback, available [0..t])`.
  `market-access.test.ts` pins e.g. `oiWindow(3)` → `[{...}, undefined, {...}]`.
- `fundingAsOf` / `takerAsOf` are **optional** methods, present iff the tape carries that kind
  (composition-following). `present`/`stale` carry a `point`; `missing` does not. For taker, `stale`
  carries no point (incomplete bucket). present-zero taker `{ buyUsd:0, sellUsd:0 }` is real "no
  flow", `missing` is a gap.

## Approach

Enrich `STRATEGY_AUTHORING_DOC` in `packages/sdk/src/builder/authoring/doc.ts` with a new section
that documents the exact method surface, point shapes, gap semantics, and a before/after example.
Replace the current vague one-liner (`ctx.market?: point-in-time open interest / liquidations /
funding / taker flow ...`) with a pointer into the new section.

Decisions (confirmed with user):
- **Scope:** all four channels documented in full (OI, liq, funding, taker).
- **Version:** bump `AUTHORING_DOC_VERSION` `1.0.0` → `1.1.0` (additive contract change; lab can
  trigger re-eval on the version delta). This is independent of the SDK package semver.

## New doc section (inserted inside `## StrategyContext`)

```markdown
## Runtime market data — ctx.market (PointInTimeMarketApi)

`ctx.market` is the point-in-time market-tape surface for the current closed bar (minute `t`).
Read-only, structurally no-lookahead (`ts ≤ t`, no forward methods). It is present only when the
tape carries that data — guard `if (!ctx.market) return idle`.

**These are METHODS, not fields.** OI is an object `{ oiTotalUsd }`, not a scalar.

### Open interest & liquidations (present when the tape carries OI / liq)

- `ctx.market.oiAsOf(): OiPoint | undefined` — OI for minute `t`; `undefined` on a gap.
- `ctx.market.oiWindow(lookback): readonly (OiPoint | undefined)[]` — last `lookback` minute
  buckets ending AT `t` inclusive (index `len-1` = minute `t`); length = `min(lookback, available)`.
- `ctx.market.liqAsOf(): LiqPoint | undefined`
- `ctx.market.liqWindow(lookback): readonly (LiqPoint | undefined)[]`

    interface OiPoint  { ts: number; oiTotalUsd: number }
    interface LiqPoint { ts: number; longUsd: number; shortUsd: number }

### Gap semantics (read carefully)

- A window slot may be `undefined` — that minute is a gap. NO carry-forward: never reuse the
  previous value across a gap.
- `liqAsOf()` → `undefined` on a gap, but `{ longUsd: 0, shortUsd: 0 }` on a covered minute with no
  liquidations. `undefined` (missing) and `{0,0}` (real "no liquidations") are DIFFERENT — branch
  on them separately.

### Funding & taker (optional — present only when the tape carries them; guard the method)

These return a 3-state reading object, NOT `Point | undefined`:

- `ctx.market.fundingAsOf?(): FundingReading`
  `= { state:'present'|'stale', point:{ ts, fundingRate } } | { state:'missing' }`
  (`stale` = bounded live-forward, still a real snapshot; `missing` = no snapshot, NOT zero).
- `ctx.market.fundingWindow?(lookback): readonly (FundingPoint | undefined)[]`
- `ctx.market.takerAsOf?(): TakerReading`
  `= { state:'present', point:{ ts, buyUsd, sellUsd } } | { state:'stale' } | { state:'missing' }`
  (present-zero `{ buyUsd:0, sellUsd:0 }` is real "no flow"; `missing` is a gap).
- `ctx.market.takerWindow?(lookback): readonly (TakerPoint | undefined)[]`

Read a reading via its `state`:

    const r = ctx.market.fundingAsOf?.();
    const rate = r?.state === 'present' ? r.point.fundingRate : undefined;

### Candles

- `ctx.data.closedCandles(lookback): readonly Bar[]` — closed bars strictly before the current bar.

### ❌ before → ✅ after

    // ❌ these fields DO NOT EXIST — always undefined → your condition is always false
    ctx.market.openInterest        ctx.market.oi
    ctx.market.liquidations.long

    // ✅ read OI / liq through the methods
    const oi     = ctx.market?.oiAsOf()?.oiTotalUsd;         // number | undefined
    const liqL   = ctx.market?.liqAsOf()?.longUsd;           // number | undefined (0 = covered-no-events)
    const oiPrev = ctx.market?.oiWindow(2)[0]?.oiTotalUsd;   // one minute back, or undefined on gap
```

## Test

In `packages/sdk/test/authoring-doc.test.ts`, add assertions that the strategy doc now documents
the market-tape surface:

- `STRATEGY_AUTHORING_DOC` contains `oiAsOf`, `oiWindow`, `liqAsOf`, `FundingReading`, `TakerReading`.
- contains the before/after anti-pattern marker (e.g. `ctx.market.openInterest`).

The existing `AUTHORING_DOC_VERSION` regex test (`/^\d+\.\d+\.\d+$/`) still passes after the bump.

## Release

After merge, cut a new SDK version via the `SDK Release` workflow
(`gh workflow run "SDK Release" --ref main -f version=<next>`), so trading-lab can bump and re-run
the F2b proof-eval. The SDK package semver is separate from `AUTHORING_DOC_VERSION`; the exact
number is decided at release time. The release trigger is an outward-facing action and is confirmed
with the user before running.

## Acceptance

- `getAuthoringDoc('strategy')` output contains the market-tape section.
- An LLM following it reads OI/liq via `ctx.market.oiWindow()` / `oiAsOf()` / `liqAsOf()`, not via
  nonexistent fields.
- Final validation is the lab-side F2b re-eval after the SDK bump (expectation: the strategy starts
  entering). Out of scope for this repo's change.

## Non-goals (YAGNI)

- No change to the runtime API itself — docs only.
- No overlay-doc change (`OVERLAY_AUTHORING_DOC` unaffected; overlays do not read `ctx.market`
  differently).
- No change to `dataNeeds` schema or manifest contract.
