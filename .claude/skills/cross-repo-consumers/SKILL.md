---
name: cross-repo-consumers
description: >-
  Find every consumer of a symbol / type / contract / SDK export across the whole
  trdlabs ecosystem (platform, sdk, lab, office, backtester, mock-platform). Use
  BEFORE changing anything shared — "who uses this?", "who consumes this SDK type?",
  "who calls this API?", "is this safe to rename?". Works from any repo folder.
---

# Cross-Repo Consumers

Answer **"who consumes `X` across the ecosystem?"** — the descriptive question you
ask *before* touching anything shared. This is packaged gortex usage: the graph
spans the whole `trading-ai` workspace, so it works the same from any component
folder.

## When to use

- Before changing / renaming a platform API, an SDK export, a shared type or contract.
- To scope a cross-repo change: "if I touch this, which repos care?"
- Distinct from `cross-repo-impact` (what *breaks*) — this is *who touches it*.

## Ecosystem map (gortex prefixes)

`trading-platform` · `trading-platform-sdk` · `trading-lab` · `trading-office` ·
`trading-backtester` · `trading-mock-platform`

## How

1. Locate the symbol: `search_symbols` (BM25, camelCase-aware) — get its `symbol_id`.
2. Every reference across repos: `find_usages` on the symbol_id (zero false positives).
   Read the results **partitioned by repo prefix** so you can see which repos consume it.
3. Cross-repo call surface: `analyze kind=cross_repo` (repo-boundary-crossing calls,
   grouped by source → target repo).
4. If the symbol is a contract / API surface: `contracts action=list` to enumerate,
   then `contracts action=check` to match consumers cross-repo.

## Ecosystem gotchas — do not miss these

- **`office` mirrors DTOs by hand, it does NOT import `@trdlabs/sdk`.** So
  `find_usages` on an SDK symbol will **not** surface office. If the symbol is a
  platform ops-read / trading-lab field, office likely consumes it via a
  hand-mirrored copy in `office/apps/server/src/connector/*/`. Always check office
  separately (`search_text` for the field name) and say so.
  See `docs/architecture/contracts/platform-office.md`.
- The real SDK contract lives in `sdk/src/{ops-read,intake,historical,research-contract,validation}`.
  Consumers import from the `@trdlabs/sdk` subpaths of the same names.

## Output

- A per-repo list of consumers (repo → files / symbols), with counts.
- Call out any consumer that is an **API-contract edge** (office) vs an **npm code**
  dependency (lab, backtester, mock-platform).
- End with a one-line verdict: is this widely consumed (high blast radius) or narrow?
