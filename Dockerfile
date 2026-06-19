# trading-backtester Dockerfile
# Single-stage: the service app runs with tsx (no tsc emit step in this workspace).
# @trading-backtester/sdk is built with tsup → dist/ (contracts/builder/client/artifacts subpaths).
# @trading-backtester/client is built with tsup → dist/ (consumed by trading-lab; frozen pending cutover).
FROM node:22-slim
WORKDIR /app
RUN corepack enable

# Install dependencies (layer-cached until lockfile changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json packages/client/
COPY packages/research-contracts/package.json packages/research-contracts/
COPY packages/sdk/package.json packages/sdk/
COPY apps/backtester/package.json apps/backtester/
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts

# Source files (tsx reads at runtime; also compile SDK and @trading-backtester/client)
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/backtester/src apps/backtester/src/
COPY apps/backtester/tsconfig.json apps/backtester/
# sandbox-harness is required at runtime (strategy sandbox execution)
COPY apps/backtester/sandbox-harness apps/backtester/sandbox-harness/
# migrations applied via pg client on first start
COPY apps/backtester/migrations apps/backtester/migrations/
# fixtures used by FixtureDataPort (BACKTESTER_DATA_SOURCE=fixture)
COPY apps/backtester/fixtures apps/backtester/fixtures/

RUN pnpm --filter @trading-backtester/sdk build
RUN pnpm --filter @trading-backtester/client build

ENV NODE_ENV=production
ENV BACKTESTER_HOST=0.0.0.0
ENV BACKTESTER_PORT=8080
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/backtester/src/index.ts"]
