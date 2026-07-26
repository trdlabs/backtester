# trading-backtester Dockerfile
# Single-stage: the service app runs with tsx (no tsc emit step in this workspace).
# @trdlabs/backtester-sdk is built with tsup → dist/ (contracts/builder/client/artifacts subpaths).
# trading-lab consumes the published @trdlabs/backtester-sdk tarball (packages/client removed in Phase 3).

# Docker CLI only (no daemon) for the DooD sandbox runner — pinned >=25 for `--mount volume-subpath`.
FROM docker:27-cli AS dockercli

FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# Install dependencies (layer-cached until lockfile changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/research-contracts/package.json packages/research-contracts/
COPY packages/sdk/package.json packages/sdk/
COPY apps/backtester/package.json apps/backtester/
# Ф3 (shared-execution-engine): the deterministic execution core is a workspace member vendored as
# a git submodule pinned at an exact `trdlabs/engine` commit. Its manifest must be present before
# install or pnpm cannot resolve the `@trdlabs/engine` workspace link.
COPY vendor/engine/package.json vendor/engine/
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

# Source files (tsx reads at runtime; also compile SDK)
COPY tsconfig.base.json ./
COPY packages/ packages/
# Engine sources — the service imports `@trdlabs/engine` at runtime, so its `dist` is built below.
COPY vendor/engine vendor/engine/
COPY apps/backtester/src apps/backtester/src/
COPY apps/backtester/tsconfig.json apps/backtester/
# sandbox harnesses are required at runtime (strategy + overlay sandbox execution)
COPY apps/backtester/sandbox-harness apps/backtester/sandbox-harness/
COPY apps/backtester/sandbox-harness-overlay apps/backtester/sandbox-harness-overlay/
COPY apps/backtester/scripts apps/backtester/scripts/
# migrations applied via pg client on first start
COPY apps/backtester/migrations apps/backtester/migrations/
# fixtures used by FixtureDataPort (BACKTESTER_DATA_SOURCE=fixture)
COPY apps/backtester/fixtures apps/backtester/fixtures/

RUN pnpm --filter @trdlabs/engine build
RUN pnpm --filter @trdlabs/backtester-sdk build
# Build the overlay harness _engine (gitignored; compiled from src/engine/indicators/**).
RUN node apps/backtester/scripts/build-sandbox-harness-overlay.mjs

ENV NODE_ENV=production
ENV BACKTESTER_HOST=0.0.0.0
ENV BACKTESTER_PORT=8080
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/backtester/src/index.ts"]
