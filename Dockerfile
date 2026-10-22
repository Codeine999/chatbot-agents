# syntax=docker/dockerfile:1

# glibc (slim) rather than alpine: sharp and bcrypt ship prebuilt glibc binaries.
ARG NODE_VERSION=22
ARG BUN_VERSION=1.4.3

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app

# bun.lock is the maintained lockfile (package-lock.json is stale), so bun
# installs dependencies; the app itself still runs on Node.
FROM oven/bun:${BUN_VERSION} AS bun

# Full deps (dev included) for build and migrations.
FROM base AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

# src/generated/prisma is gitignored, so the client must be generated here.
FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

# One-off migration image: docker build --target migrate, then run `npm run db:deploy`.
FROM build AS migrate
CMD ["npm", "run", "db:deploy"]

FROM base AS prod-deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --production

FROM base AS runner
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p uploads && chown node:node uploads
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.* ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/src/main"]
