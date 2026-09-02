# Signal — production image (F3 deploy). Builds the token bundle, the web-core SDK,
# and the dashboard SPA, then runs the Fastify API (which serves the API + the /app
# dashboard + the landing page same-origin) via tsx.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install with the frozen lockfile, using only manifests for cache reuse
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/web-core/package.json packages/web-core/package.json
RUN pnpm install --frozen-lockfile

# ---- build: generate tokens, build web-core (dist) + dashboard (dist)
FROM deps AS build
COPY . .
RUN node packages/tokens/scripts/generate.mjs \
 && pnpm --filter @signal/web-core build \
 && pnpm --filter @signal/dashboard build

# ---- runtime: run the API via tsx (needs source + devDep tsx, both present here)
FROM build AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DASHBOARD_DIST=/repo/apps/dashboard/dist
EXPOSE 3000
# Run DB migrations (idempotent, with connect-retry for the platform's private
# network) then start the API. The DB is only reachable from inside the platform.
CMD ["sh", "-c", "pnpm --filter @signal/api exec tsx src/scripts/migrate.ts && pnpm --filter @signal/api start"]
