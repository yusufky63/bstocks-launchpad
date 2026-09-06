# StockPair indexer: one long-running Node process that follows Base and writes to Postgres.
# Build from the repository root:  docker build -f apps/indexer/Dockerfile -t stockpair-indexer .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile --filter @stockpair/indexer... --prod=false

FROM deps AS runtime
COPY packages/core packages/core
COPY apps/indexer apps/indexer
WORKDIR /app/apps/indexer
ENV NODE_ENV=production
# Health endpoint for the platform's checks (Railway, Fly, Render, ECS): GET /health on this port.
EXPOSE 8788
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
