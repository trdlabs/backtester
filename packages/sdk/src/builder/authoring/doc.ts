import type { ModuleKind } from '../../contracts/module';

/** Bumped whenever the authoring contract (forms/fields/conventions) changes. */
export const AUTHORING_DOC_VERSION = '1.0.0';

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

- \`ctx.bar\`: \`{ ts, open, high, low, close, volume }\` — the just-closed bar.
- \`ctx.position\`: \`{ side, size, entryPrice, stop?, take? } | null\`.
- \`ctx.data.closedCandles(lookback)\`: closed bars strictly before the current bar (as-of).
- \`ctx.data.indicatorAsOf(name)\`: scalar indicator as-of, or undefined in warmup.
- \`ctx.indicators.query({ name, params?, source? })\`: per-bar indicator value, undefined in warmup.
- \`ctx.market?\`: point-in-time open interest / liquidations / funding / taker flow (present only
  when the tape carries that data).
- \`ctx.params\`: the manifest \`params\` payload.
- \`ctx.clock.now()\`, \`ctx.rng.next()\`: deterministic clock + seeded RNG.

## Decision forms (StrategyDecision)

- \`{ kind: 'enter', side: 'long'|'short', stop?, take?, ttl?, sizingHint?, tags?, rationale? }\`
- \`{ kind: 'exit', target: string, percent?, reason? }\`
- \`{ kind: 'add_to_position', mode: 'dca'|'scale_in', sizingHint? }\`
- \`{ kind: 'update_protection', stop?, take? }\`
- \`{ kind: 'annotate', tags?, metrics?, rationale? }\`
- \`{ kind: 'idle' }\`

A hook may return one decision, an array of decisions, or null (treated as idle).

## Manifest

\`\`\`
{
  id, version, kind: 'strategy', name, summary, rationale,
  author: 'agent'|'human', status: 'research_only',
  contractVersion: '017.2', bundleContractVersion: '019.1',
  hooks: ['onBarClose', 'onPositionBar'],
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true, ... },
  capabilities: { platformSdk: true },
  paramsSchema: { /* JSON Schema of params */ },
  params: { /* default params */ }
}
\`\`\`

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
