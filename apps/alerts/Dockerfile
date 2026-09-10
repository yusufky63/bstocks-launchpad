# BaseStocks alerts: reads the outbox the indexer fills and posts to one Telegram channel.
# Build from the repository root:  docker build -f apps/alerts/Dockerfile -t basestocks-alerts .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/alerts/package.json apps/alerts/
RUN pnpm install --frozen-lockfile --filter @stockpair/alerts... --prod=false

FROM deps AS runtime
COPY packages/core packages/core
COPY apps/alerts apps/alerts
WORKDIR /app/apps/alerts
ENV NODE_ENV=production
# Health endpoint for the platform's checks: GET /health on this port.
EXPOSE 8789
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
