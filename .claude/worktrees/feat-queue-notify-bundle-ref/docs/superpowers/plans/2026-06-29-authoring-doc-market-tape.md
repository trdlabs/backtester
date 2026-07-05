# Authoring Doc Market-Tape API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the runtime `ctx.market` (PointInTimeMarketApi) surface in `getAuthoringDoc('strategy')` so an LLM authoring a strategy bundle reads OI/liq/funding/taker through the real methods instead of guessing nonexistent fields.

**Architecture:** Pure doc-content change to the `STRATEGY_AUTHORING_DOC` template literal in the SDK builder surface, plus a version bump and a guard test. No runtime API change. The doc text is mirrored 1:1 against the kernel contract `market-tape.d.ts`.

**Tech Stack:** TypeScript, Vitest, pnpm workspace (`packages/sdk`).

## Global Constraints

- SDK public `.d.ts` must stay free of Node globals (`Buffer`, etc.) — not relevant here (doc.ts exports only strings + a string function) but do not introduce imports.
- `doc.ts` uses **no `import`** except the existing `import type { ModuleKind }`. Keep it type-only; the doc is a plain template-literal string.
- Template-literal backticks inside the doc string MUST be escaped as `` \` `` (existing convention in the file). Code fences inside the doc use indented blocks (4-space) where they contain backticks, matching the proposed section.
- `AUTHORING_DOC_VERSION` is the authoring-contract version (`1.0.0` → `1.1.0`); it is **separate** from the SDK package semver.
- Run all commands from repo root `/home/alexxxnikolskiy/projects/trading-backtester`.

---

### Task 1: Document `ctx.market` in the strategy authoring doc + bump version

**Files:**
- Modify: `packages/sdk/src/builder/authoring/doc.ts` (the `AUTHORING_DOC_VERSION` constant at line 4, and the `STRATEGY_AUTHORING_DOC` template literal — replace the `ctx.market?:` bullet, line ~38, and add the new section)
- Test: `packages/sdk/test/authoring-doc.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `STRATEGY_AUTHORING_DOC` (string) now contains a `## Runtime market data — ctx.market (PointInTimeMarketApi)` section; `AUTHORING_DOC_VERSION === '1.1.0'`. `getAuthoringDoc('strategy')` returns the enriched string. No signature changes.

- [ ] **Step 1: Write the failing tests**

Add these assertions to `packages/sdk/test/authoring-doc.test.ts` inside the existing `describe('authoring docs', ...)` block, after the `'strategy doc documents the entry convention and both phases'` test:

```typescript
  it('strategy doc documents the runtime market-tape API (methods, not fields)', () => {
    // the four core methods + reading types
    expect(STRATEGY_AUTHORING_DOC).toContain('oiAsOf');
    expect(STRATEGY_AUTHORING_DOC).toContain('oiWindow');
    expect(STRATEGY_AUTHORING_DOC).toContain('liqAsOf');
    expect(STRATEGY_AUTHORING_DOC).toContain('liqWindow');
    expect(STRATEGY_AUTHORING_DOC).toContain('FundingReading');
    expect(STRATEGY_AUTHORING_DOC).toContain('TakerReading');
    // point shapes
    expect(STRATEGY_AUTHORING_DOC).toContain('oiTotalUsd');
    // gap semantics: undefined vs covered-zero must be called out
    expect(STRATEGY_AUTHORING_DOC).toContain('covered-no-events');
    // before/after anti-pattern: the nonexistent field the LLM guessed
    expect(STRATEGY_AUTHORING_DOC).toContain('ctx.market.openInterest');
  });

  it('bumps the authoring doc version for the market-tape addition', () => {
    expect(AUTHORING_DOC_VERSION).toBe('1.1.0');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @trading-backtester/sdk test -- authoring-doc`
Expected: FAIL — the two new tests fail (`expected ... to contain 'oiAsOf'`, and `expected '1.0.0' to be '1.1.0'`). The existing tests still pass.

(If `--filter @trading-backtester/sdk` is not the exact package name, confirm with `node -p "require('./packages/sdk/package.json').name"` and use that; the Vitest invocation is `pnpm --filter <name> test`.)

- [ ] **Step 3: Bump the version**

In `packages/sdk/src/builder/authoring/doc.ts`, change line 4:

```typescript
export const AUTHORING_DOC_VERSION = '1.1.0';
```

- [ ] **Step 4: Replace the `ctx.market?` bullet with a pointer**

In the `## StrategyContext (read-only, deep-frozen)` list, replace this bullet:

```
- \`ctx.market?\`: point-in-time open interest / liquidations / funding / taker flow (present only
  when the tape carries that data).
```

with:

```
- \`ctx.market?\`: point-in-time market-tape surface (OI / liquidations / funding / taker), present
  only when the tape carries that data — see "Runtime market data" below for the exact methods.
```

- [ ] **Step 5: Insert the new section**

Insert the following section into the `STRATEGY_AUTHORING_DOC` template literal **immediately after** the `## StrategyContext (read-only, deep-frozen)` bullet list (i.e. after the `ctx.clock.now()` bullet) and **before** the `## Decision forms (StrategyDecision)` heading. Note: every backtick is escaped as `` \` `` because this lives inside a template literal.

```
## Runtime market data — \`ctx.market\` (PointInTimeMarketApi)

\`ctx.market\` is the point-in-time market-tape surface for the current closed bar (minute \`t\`).
Read-only, structurally no-lookahead (\`ts ≤ t\`, no forward methods). It is present only when the
tape carries that data — guard \`if (!ctx.market) return { kind: 'idle' };\`.

**These are METHODS, not fields.** OI is an object \`{ oiTotalUsd }\`, not a scalar.

### Open interest & liquidations (present when the tape carries OI / liq)

- \`ctx.market.oiAsOf(): OiPoint | undefined\` — OI for minute \`t\`; \`undefined\` on a gap.
- \`ctx.market.oiWindow(lookback): readonly (OiPoint | undefined)[]\` — last \`lookback\` minute
  buckets ending AT \`t\` inclusive (index \`len-1\` = minute \`t\`); length = \`min(lookback, available)\`.
- \`ctx.market.liqAsOf(): LiqPoint | undefined\`
- \`ctx.market.liqWindow(lookback): readonly (LiqPoint | undefined)[]\`

    interface OiPoint  { ts: number; oiTotalUsd: number }
    interface LiqPoint { ts: number; longUsd: number; shortUsd: number }

### Gap semantics (read carefully)

- A window slot may be \`undefined\` — that minute is a gap. NO carry-forward: never reuse the
  previous value across a gap.
- \`liqAsOf()\` → \`undefined\` on a gap, but \`{ longUsd: 0, shortUsd: 0 }\` on a covered minute with
  no liquidations (covered-no-events). \`undefined\` (missing) and \`{0,0}\` (real "no liquidations")
  are DIFFERENT — branch on them separately.

### Funding & taker (optional — present only when the tape carries them; guard the method)

These return a 3-state reading object, NOT \`Point | undefined\`:

- \`ctx.market.fundingAsOf?(): FundingReading\`
  = \`{ state:'present'|'stale', point:{ ts, fundingRate } } | { state:'missing' }\`
  (\`stale\` = bounded live-forward, still a real snapshot; \`missing\` = no snapshot, NOT zero).
- \`ctx.market.fundingWindow?(lookback): readonly (FundingPoint | undefined)[]\`
- \`ctx.market.takerAsOf?(): TakerReading\`
  = \`{ state:'present', point:{ ts, buyUsd, sellUsd } } | { state:'stale' } | { state:'missing' }\`
  (present-zero \`{ buyUsd:0, sellUsd:0 }\` is real "no flow"; \`missing\` is a gap).
- \`ctx.market.takerWindow?(lookback): readonly (TakerPoint | undefined)[]\`

Read a reading via its \`state\`:

    const r = ctx.market.fundingAsOf?.();
    const rate = r?.state === 'present' ? r.point.fundingRate : undefined;

### Candles

- \`ctx.data.closedCandles(lookback): readonly Bar[]\` — closed bars strictly before the current bar.

### ❌ before → ✅ after

    // ❌ these fields DO NOT EXIST — always undefined → your condition is always false
    ctx.market.openInterest        ctx.market.oi
    ctx.market.liquidations.long

    // ✅ read OI / liq through the methods
    const oi     = ctx.market?.oiAsOf()?.oiTotalUsd;         // number | undefined
    const liqL   = ctx.market?.liqAsOf()?.longUsd;           // number | undefined (0 = covered-no-events)
    const oiPrev = ctx.market?.oiWindow(2)[0]?.oiTotalUsd;   // one minute back, or undefined on gap
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @trading-backtester/sdk test -- authoring-doc`
Expected: PASS — all tests in `authoring-doc.test.ts` green (existing 4 + 2 new).

- [ ] **Step 7: Typecheck / build the SDK**

Run: `pnpm --filter @trading-backtester/sdk build`
Expected: build succeeds. (Confirms the template literal still parses — an unescaped backtick would break the build here.) If the package has a separate `typecheck` script, run it too.

- [ ] **Step 8: Full SDK test suite (regression)**

Run: `pnpm --filter @trading-backtester/sdk test`
Expected: PASS — no other SDK test regressed.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk/src/builder/authoring/doc.ts packages/sdk/test/authoring-doc.test.ts
git commit -m "feat(sdk): document ctx.market runtime API in getAuthoringDoc (v1.1.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation (out of plan, confirmed with user before running)

- Open PR for the branch `feat/authoring-doc-market-tape`.
- After merge: cut a new SDK release via `gh workflow run "SDK Release" --ref main -f version=<next>` so trading-lab can bump and re-run the F2b proof-eval. Exact version decided at release time. **Outward-facing — confirm with user first.**

## Self-Review

**Spec coverage:**
- New section documenting `ctx.market` methods + shapes — Task 1 Step 5. ✓
- All 4 channels (OI/liq/funding/taker) full — Task 1 Step 5. ✓
- C1 gap semantics (`undefined` vs `{0,0}`; no carry-forward) — Task 1 Step 5 "Gap semantics" + asserted (`covered-no-events`) in Step 1. ✓
- 3-state reading distinction for funding/taker — Task 1 Step 5 + asserted (`FundingReading`/`TakerReading`). ✓
- `closedCandles` retained — Task 1 Step 5 "Candles". ✓
- before/after example — Task 1 Step 5 + asserted (`ctx.market.openInterest`). ✓
- Version bump to 1.1.0 — Task 1 Step 3 + asserted. ✓
- Replace vague bullet — Task 1 Step 4. ✓
- Guard test — Task 1 Step 1. ✓
- Release — Post-implementation section (out of plan, gated on user). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; all doc text and test code shown verbatim.

**Type consistency:** Method names (`oiAsOf`/`oiWindow`/`liqAsOf`/`liqWindow`/`fundingAsOf`/`fundingWindow`/`takerAsOf`/`takerWindow`), point fields (`oiTotalUsd`/`longUsd`/`shortUsd`/`fundingRate`/`buyUsd`/`sellUsd`), and reading union shapes match `market-tape.d.ts` and the test assertions consistently.
