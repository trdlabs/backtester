---
name: cross-repo-impact
description: >-
  Predict what BREAKS across the trdlabs ecosystem if you change a symbol / signature
  / contract — broken callers, interface implementors, contract violations, test
  targets, across platform / sdk / lab / office / backtester / mock-platform. Use
  BEFORE committing a shared change — "what breaks if I change X?", "is this safe?",
  "blast radius". Works from any repo folder.
---

# Cross-Repo Impact

Answer **"what breaks across the ecosystem if I change `X` this way?"** — the
predictive / safety question you ask *before committing* a shared change. Distinct
from `cross-repo-consumers` (who *touches* it): this is what *fails* under **this**
change.

## When to use

- Before changing a signature, a return type, a contract field, an SDK export.
- Before deleting / renaming something shared.
- To decide whether a change is mechanical or needs consumer adaptation.

## How

1. Find the symbol: `search_symbols` → `symbol_id`.
2. Blast radius: `explain_change_impact` (or `verify_change` with the proposed new
   signature) — broken callers + interface implementors across repos.
3. Reverse dependencies: `get_dependents` for the symbol / file.
4. Contract violations: `contracts action=check` — does the change break a
   cross-repo contract match?
5. What to re-test: `get_test_targets` per affected repo.
6. For a value/shape change, trace where it flows: `flow_between` / `taint_paths`.

## Ecosystem gotchas — do not miss these

- **`office` will not appear in `verify_change` / `get_dependents` for SDK symbols**
  — it hand-mirrors the DTOs (`office/apps/server/src/connector/*/`), so a contract
  change there breaks office **silently** (its mirror goes stale). If the change
  touches a platform ops-read / trading-lab field, flag: "office mirrors this by
  hand — update `*/connector/*/*Dtos.ts` manually." See
  `docs/architecture/contracts/platform-office.md`.
- **`backtester` consumes the SDK kernel** (`@trdlabs/sdk/{validation,historical,research-contract}`)
  and has equivalence tests (`validator-kernel-equivalence`, `evidence-kernel-singlesource`,
  `rows-data-port`) — a kernel-surface change must be validated by running those, not
  assumed. Name them in the test-target output.

## Sequence a real change

Follow `docs/delivery/cross-repo-change-playbook.md`: source-of-truth first
(platform → sdk → consumers), validate each, then coordinated PRs. Record the
known-good set with `pnpm record-release`.

## Output

- A per-repo breakage list: broken callers / implementors / contract mismatches.
- The test targets to run per affected repo (incl. backtester's equivalence tests
  and office's hand-mirror if relevant).
- A verdict: **mechanical** (rename/additive, safe) vs **breaking** (needs consumer
  adaptation + validation), with the recommended merge order.
