# Sandbox execution topology — analysis & decision record

**Status:** Decision settled (2026-06-22) — input brief for implementation in this repo.
**Author context:** produced from a cross-repo session driving `trading-lab` (the consumer). This doc is the **brief** for a `trading-backtester` Claude Code instance to run its own `superpowers:brainstorming → writing-plans → subagent-driven-development` against. It is NOT itself the implementation spec — it records the settled decision and scopes the work.

## Background

The system spans four repos: `trading-lab` (research orchestrator), `trading-office` (UI), `trading-platform` / `trading-mock-platform` (market data + ops), and **`trading-backtester`** (this repo — the backtest service). The demo (`trading-lab`'s `make demo`) runs everything in one `docker compose` — convenient for distribution.

The backtester executes each **untrusted, generated strategy module** inside a per-run, locked-down **Docker sandbox container** (`--network none`, `--read-only`, tmpfs, `--cap-drop ALL`, `--security-opt no-new-privileges`, memory/cpu/pids limits, non-root, `--disallow-code-generation-from-strings`). Only the strategy's decision logic runs in the sandbox (emits signals over stdio IPC); market data, portfolio sizing, PnL and metrics stay in the **trusted** backtester engine. This isolation is the whole point and must be preserved — disabling the sandbox for research overlays is NOT an option.

## The problem (root cause, observed live 2026-06-22)

In the demo, the backtester itself runs **inside a container** and the sandbox runner crashes immediately:

```
Error: spawn docker ENOENT
  path: 'docker'
  spawnargs: ['run','-i','--name','sbx-<runId>--variant-overlay-<hypId>-...',
              '--network','none','--read-only','--tmpfs','/tmp:...','--memory',...,
              '-v','/tmp/btx-bundle-XXXX:/sandbox/bundle:ro',
              '-v','/app/apps/backtester/sandbox-harness-overlay:/sandbox/harness:ro',
              'node:24-bookworm-slim@sha256:...','node','--disallow-...','/sandbox/harness/entry.mjs']
```

Two distinct causes, both must be fixed:

1. **No `docker` CLI inside the backtester image** → `spawn docker ENOENT` → the backtester process dies, the run stays `submitted` forever, no `backtest.completed`, no callback. (This is also a `trading-lab` symptom only as a downstream effect — there is no lab/PR2b bug here.)
2. **Bind-mount path aliasing (latent, would surface after #1).** The runner mounts `-v <hostpath>:/sandbox/bundle` and `-v <harnessdir>:/sandbox/harness`. When the backtester runs in a container and talks to the host daemon (DooD), the daemon resolves `-v` SOURCE paths against the **host** filesystem, not the backtester container's filesystem. So `/tmp/btx-bundle-XXXX` (written inside the backtester container) and `/app/.../sandbox-harness-overlay` (baked into the image) do **not** exist on the host → the sandbox would get empty/wrong mounts.

It is **not** a WSL2 problem (WSL2 runs Docker fine) and **not** a VPS-vs-laptop problem — the identical compose fails identically anywhere the backtester is containerized without Docker access. It is purely "the containerized backtester has no path to a Docker daemon + its mount paths don't resolve on the host."

## Settled decision — three run profiles

| Profile | Stateful infra | App services | Backtester ↔ sandbox |
|---|---|---|---|
| **demo** (`make demo`, one command) | all in docker | in docker | backtester in docker + **DooD**: mount host `/var/run/docker.sock`, `docker` CLI in the image, sandbox runs as a **sibling** container on the host daemon |
| **dev** (local iteration) | docker: postgres + redis (+ mock-platform) | **host processes** with watch, via one orchestration script | **backtester on host** → its `docker run` hits the host daemon natively; **no DooD needed**, no path aliasing |
| **prod** (server) | containers / k8s | containers | DooD / `docker:dind` sidecar now; a real sandbox runtime (gVisor / Kata / Firecracker) later — note only, out of scope here |

Chosen DooD mechanism for demo: **host socket + a shared named docker volume** for the bundle (and harness) — NOT host bind-mounts. A named volume is resolved by the daemon regardless of the caller's filesystem, which makes the same sandbox-run code work whether the backtester is containerized (DooD) or a host process (dev). This is the key insight that removes the path-aliasing class of bugs entirely.

## Scope for THIS repo (trading-backtester)

The backtester-internal changes. The implementer should confirm all specifics against the code before designing — the overlay engine path (`BACKTESTER_ENABLE_OVERLAY_ENGINE=true`, used by the demo) lives under `apps/backtester/src/engine/sandbox/` (`docker-driver.ts` `buildDockerRunArgs` / `DockerRunOptions`, `sandbox-executor.ts`, `sandbox-session.ts`, `ipc.ts`, `bundle-materialize.ts`, plus `config.ts` for `BACKTESTER_SANDBOX_*` and `harnessDir`); a legacy path exists under `apps/backtester/src/sandbox/` (`docker.ts` `buildRunArgs`) — decide whether it is still reachable and in scope.

1. **`docker` CLI available to the sandbox runner** when the backtester is containerized — install it in the backtester image (Dockerfile) so `spawn('docker', …)` resolves. (For host-process/dev mode it is already on the host.)
2. **Mount bundle + harness via a shared named volume instead of host bind-mounts.** Design the volume layout so both the backtester (writer) and the sandbox container (reader) see the per-run bundle + the harness at the expected `/sandbox/bundle` and `/sandbox/harness`. Open design choice for the implementer: a **volume-per-run** vs **one shared volume with a per-run subdir keyed by runId** (note: `docker run -v <vol>:/path` mounts the whole volume; subpath mounting needs a per-run volume or a run-id subdir the harness reads). The harness overlay (currently baked into the image at `/app/.../sandbox-harness-overlay`) must become reachable from the volume context — copy-into-volume on startup, or a separate harness volume, or ship it via the bundle.
3. **Dual-mode correctness.** The same runner must work in BOTH: (a) containerized-with-DooD (demo), and (b) backtester-as-host-process (dev). A named volume works in both; verify host-process mode is not regressed. Keep the existing locked-down flags (`--network none`, `--read-only`, tmpfs, cap-drop, no-new-privileges, limits, non-root, `--disallow-code-generation-from-strings`) and the per-run lifecycle (no `--rm`; explicit `docker rm -f` on close) unchanged.
4. **Tests:** unit-cover the run-arg construction (named volume present, no host-path bind-mount for bundle/harness; flags preserved). Whatever integration/characterization tests exist for the sandbox session should stay green.

## Companion tasks — same initiative, land in `trading-lab` (this instance owns them too)

This is one cross-repo initiative; the instance running here owns the full vertical (it defines the contract, so it should also wire the consumer). These changes live in the **`trading-lab`** repo (sibling at `../trading-lab` / `/home/alexxxnikolskiy/projects/trading-lab`) — make them on a **separate `trading-lab` branch and PR**, after the backtester contract (named-volume name, docker-CLI image expectation, socket requirement) is fixed:

1. **demo compose wiring** (`trading-lab/docker-compose.yml` + `docker-compose.demo.yml`): mount `/var/run/docker.sock` into the `backtester` service, declare the shared named volume, ensure the demo uses the docker-CLI-bearing image. Reference the volume name + contract this repo defines. (Note: `OPERATOR_DOWNSTREAM_BACKTESTS=true` is already enabled on the office-server demo override, so once the backtester completes runs organically, the operator's proactive message flows without the `/tasks` injection.)
2. **dev orchestration script** (minimal-docker): one script that does `docker compose up -d postgres redis mock-platform`, then launches the app services (lab ingress/worker/read-api, office server/web, backtester) as host processes with watch via `mprocs`/`concurrently`/Procfile — backtester on host so the sandbox runs natively (no DooD in dev). Lives in `trading-lab` (the hub; it already references sibling paths via `TRADING_OFFICE_PATH`/`TRADING_BACKTESTER_PATH`).

Sequence the initiative: settle the contract → backtester impl (this repo) → lab compose wiring + dev script (trading-lab repo) → verify the demo backtest completes organically.

## Constraints / invariants (must hold)

- **Sandbox isolation is non-negotiable** — every existing lockdown flag stays; do not add a "trusted/in-process for research overlays" bypass. (A trusted executor exists for first-party modules; research overlays must stay sandboxed.)
- **Per-run container lifecycle** stays (one ephemeral sandbox container per backtest run, deterministic `docker rm -f` cleanup). This change is about WHERE/HOW it mounts, not the lifecycle.
- **Security note (document it):** mounting the host docker socket grants the backtester container effective host-root. Acceptable for demo/local; for prod prefer a `dind` sidecar or a real sandbox runtime. Surface this in the design's risk section.
- **Performance is a non-goal here.** A warm/pooled sandbox container is a SEPARATE future optimization (and only safe as "warm container + fresh process + tmpfs reset per run"; reusing one process across untrusted strategies leaks state). Do not fold it into this change.

## Acceptance (definition of done)

- **demo:** `make demo` (with the lab-side companion wiring) runs a real research backtest end-to-end — the sandbox spawns as a sibling container, the strategy executes, the backtester posts the `backtest-completed` callback, and `trading-lab` reaches a real `backtest.completed` (→ `backtest.result_ready` → the operator's proactive message, organically, without the `/tasks` injection used during the 2026-06-22 live-verify).
- **dev:** the backtester run as a host process spawns the sandbox natively (no DooD), unchanged behavior.
- Sandbox lockdown flags + per-run cleanup verified intact; backtester test suite green.

## Pointers

- Live-verify + root-cause evidence and the broader operator context live in `trading-lab` (PR2b: `docs/superpowers/specs/2026-06-22-pr2b-downstream-backtest-surfacing-design.md`, roadmap). The demo backtest gap is what motivated this analysis.
- Sandbox security model: `trading-platform/specs/019-sandbox-module-gateway/` (the canonical design this repo mirrors).
