import type { ModuleKind } from '../../contracts/module';

/** Bumped whenever the authoring contract (forms/fields/conventions) changes. */
export const AUTHORING_DOC_VERSION = '1.3.0';

export const STRATEGY_AUTHORING_DOC = `# Authoring a strategy bundle

A strategy bundle is a single **self-contained ESM** file. It must:

- \`export default function createStrategyModule(params)\` returning a \`StrategyModule\`.
- Use **no** \`import\`/\`require\` — pre-built JS only (FR-003). V8 executes it directly.
- Be **deterministic** — read only \`ctx\`; never use \`Date.now()\` or \`Math.random()\`
  (use \`ctx.clock.now()\` and \`ctx.rng.next()\`).

## StrategyModule

\`\`\`
{ manifest, init?, onBarClose, onPositionBar?, onPendingIntentBar?, dispose? }
\`\`\`

\`onBarClose\` is the only required hook.

## Lifecycle phases

- **Flat phase — \`onBarClose(ctx)\`**: runs every closed bar while there is no position.
  Return an \`enter\` decision to open a position, or \`idle\`.
- **Management phase — \`onPositionBar(ctx)\`**: runs every bar while a position is open
  (\`ctx.position\` is non-null). Return \`exit\`, \`add_to_position\`, \`update_protection\`,
  \`annotate\`, or \`idle\`.

## StrategyContext (read-only, deep-frozen)

These are the ONLY properties on \`ctx\` — there is no \`ctx.state\`, \`ctx.trade\`, or \`ctx.equity\`.

- \`ctx.bar\`: \`{ ts, open, high, low, close, volume }\` — the just-closed bar.
- \`ctx.position\`: \`{ side, size, entryPrice, stop?, take? } | null\` — the open position (null while flat).
  The position lives HERE, not under \`ctx.state\`.
- \`ctx.pendingIntent\`: pending-entry snapshot \`| null\` (only relevant inside \`onPendingIntentBar\`).
- \`ctx.portfolio\`: account-level snapshot (equity / exposure). \`ctx.symbol\`: the traded symbol string.
  \`ctx.run\`: run metadata.
- \`ctx.data.closedCandles(lookback): readonly Bar[]\`: closed bars strictly before the current bar
  (as-of), **oldest→newest** — index \`0\` is the oldest, index \`len-1\` is the most recent closed bar.
- \`ctx.data.indicatorAsOf(name)\`: scalar indicator as-of, or undefined in warmup.
- \`ctx.indicators.query({ name, params?, source? })\`: per-bar indicator value, undefined in warmup.
- \`ctx.market?\`: point-in-time market-tape surface (OI / liquidations / funding / taker), present
  only when the tape carries that data — see "Runtime market data" below for the exact methods.
- \`ctx.params\`: the manifest \`params\` payload.
- \`ctx.clock.now()\`, \`ctx.rng.next()\`: deterministic clock + seeded RNG.

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

## Decision forms (StrategyDecision)

A closed union of exactly six \`kind\`s. Each form is \`additionalProperties: false\` — any field NOT
listed for that \`kind\` is schema-invalid. \`?\` marks optional; everything else is required.

- \`{ kind: 'enter', side: 'long'|'short', stop?: number, take?: number, ttl?: number, sizingHint?: number, tags?: string[], rationale?: string, entry?: object, evidenceRefs?: string[] }\`
  — \`side\` is REQUIRED (direction lives in the decision, not globally).
- \`{ kind: 'exit', target: string, percent?: number, reason?: string }\` — \`target\` is REQUIRED (e.g. \`'all'\`).
- \`{ kind: 'add_to_position', mode: 'dca'|'scale_in', sizingHint?: number }\` — \`mode\` is REQUIRED.
- \`{ kind: 'update_protection', stop?: number, take?: number }\`
- \`{ kind: 'annotate', tags?: string[], metrics?: object, rationale?: string }\`
- \`{ kind: 'idle' }\`

A hook may return one decision, an array of decisions, or null (treated as idle).

\`sizingHint\` (on \`enter\` and \`add_to_position\`) is a **number** — a notional-% sizing hint
(e.g. \`5\` = 5% of equity), clamped by the risk profile. It is a scalar, NOT an object:

    // ❌ schema-invalid — rejected ("sizingHint: must be number")
    { kind: 'add_to_position', mode: 'dca', sizingHint: { multiplier: 1.5 } }
    // ✅ a number
    { kind: 'add_to_position', mode: 'dca', sizingHint: 1.5 }

## Data needs — \`manifest.dataNeeds\` (CLOSED catalog)

\`dataNeeds\` is a flat map of **boolean** flags declaring which point-in-time data the strategy reads.
It is a DECLARATIVE contract of expectations, NOT a permission gate — \`ctx.market\` is populated from
the tape's composition, never from this map (FR-010). Set a flag \`true\` ONLY for data you actually read.

**The flag names are a closed vocabulary.** Any \`true\` flag whose name is NOT one of the names below →
the bundle is rejected with \`unsupported_market_data_kind\`. Do NOT invent flag names.

### ✅ Legitimate market / structural needs (set \`true\` when read)

- \`closedCandlesUpToCurrent: boolean\` — closed OHLCV candles up to the current bar (\`ctx.data.closedCandles\`).
- \`asOfIndicators: boolean\` — as-of indicator reads (\`ctx.data.indicatorAsOf\` / \`ctx.indicators.query\`).
- \`openInterest: boolean\` — point-in-time open interest (\`ctx.market.oiAsOf\` / \`oiWindow\`).
- \`liquidations: boolean\` — point-in-time liquidations (\`ctx.market.liqAsOf\` / \`liqWindow\`).
- \`funding: boolean\` — funding snapshots (\`ctx.market.fundingAsOf\` / \`fundingWindow\`).
- \`taker: boolean\` — taker buy/sell flow (\`ctx.market.takerAsOf\` / \`takerWindow\`).

### ❌ Lookahead flags → \`lookahead_violation\` (recognized names, but NEVER set \`true\`)

\`forwardBars\`, \`forwardWindow\`, \`oracle\`, \`labeling\`, \`postTradeOutcome\`.

### ❌ Non-determinism flags → \`nondeterminism_violation\` (NEVER set \`true\`)

\`wallClock\`, \`uncontrolledRandom\`.

### Mapping guide (intent → flag) — do NOT invent sub-types

- "candles" / "price" / "OHLCV" / "volume" → \`closedCandlesUpToCurrent\`
  (NOT \`candles\`, \`priceData\`, \`volume\`, \`ohlcv\`).
- "open interest" / "OI" → \`openInterest\` (NOT \`oi\`).
- "liquidations" — long AND short → the single flag \`liquidations\`
  (NOT \`longLiquidations\` / \`shortLiquidations\`; the long/short split lives inside \`LiqPoint\`, not in a flag).
- "funding rate" → \`funding\`.  "taker / aggressor flow" → \`taker\`.

    // ❌ unsupported_market_data_kind — invented names outside the catalog
    dataNeeds: { priceData: true, candles: true, longLiquidations: true, volume: true }
    // ✅ every flag is a catalog name; true only for data actually read
    dataNeeds: { closedCandlesUpToCurrent: true, openInterest: true, liquidations: true }

## Manifest

\`\`\`
{
  id, version, kind: 'strategy', name, summary, rationale,
  author: 'agent'|'human', status: 'research_only',
  contractVersion: '017.2', bundleContractVersion: '019.1',
  hooks: ['onBarClose', 'onPositionBar'],
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true /* closed catalog — see above */ },
  capabilities: { platformSdk: true },
  paramsSchema: { /* JSON Schema of params */ },
  params: { /* default params */ }
}
\`\`\`

\`contractVersion\` / \`bundleContractVersion\` are pinned by the SDK builder — do not invent values.
The bundle wraps the manifest + entry + files; \`bundleHash\` is the sha256 of the raw ESM bytes.
`;

export const OVERLAY_AUTHORING_DOC = `# Authoring an overlay (hypothesis) bundle

An overlay intervenes at exactly one point in a base strategy via the \`apply\` hook. Like a
strategy bundle it is a self-contained ESM with \`export default function createStrategyModule(params)\`,
but the returned module is \`{ manifest, init?, apply }\`.

## apply(ctx)

Runs at the overlay's interception point. Returns an \`OverlayDecision\`:

- \`{ kind: 'pass' }\` — leave the base decision unchanged.
- \`{ kind: 'veto', reasonCode: string, rationale? }\` — terminal for the current base decision.
- \`{ kind: 'patch', patch: object }\` — structural patch over the base decision (stays schema-valid).
- \`{ kind: 'annotate', tags?, notes? }\` — metadata only.

## Manifest

Same shape as a strategy, with \`kind: 'overlay'\`, \`hooks: ['apply']\`, and (optionally)
\`targetStrategyRef\` + \`interceptionPoint\`.
`;

/** Return the authoring doc for a module kind. */
export function getAuthoringDoc(kind: ModuleKind): string {
  return kind === 'overlay' ? OVERLAY_AUTHORING_DOC : STRATEGY_AUTHORING_DOC;
}
