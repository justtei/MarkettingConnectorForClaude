# One image per service, built from the monorepo:
#   docker build --target app -t sandalez-app .   (api, mcp, worker, migrations — pick the command)
#   docker build --target web -t sandalez-web .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /repo

# ---- dependencies (cached unless a manifest changes)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/meta-mock/package.json packages/meta-mock/
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ---- source + Prisma client
FROM deps AS source
COPY . .
RUN pnpm --filter @sandalez/db exec prisma generate

# ---- api / mcp / worker / migrate (TypeScript run with tsx)
FROM source AS app
ENV NODE_ENV=production
USER node
# Default: API. docker-compose overrides the command per service.
CMD ["pnpm", "--filter", "@sandalez/api", "start"]

# ---- dashboard build
FROM source AS web-build
RUN pnpm --filter web build

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
