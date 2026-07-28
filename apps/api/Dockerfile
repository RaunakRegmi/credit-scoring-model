# ONE BNPL AICS — NestJS API.
#
# Multi-stage: the builder carries the full toolchain and dev dependencies, the runtime carries
# only compiled output and production dependencies. That matters here beyond image size — the
# accepted audit exception in the root package.json applies to eslint and the Nest CLI, and this
# is what keeps them out of the deployed image.

# ---------- builder ----------
FROM node:22-slim AS builder

WORKDIR /repo

# OpenSSL is needed by Prisma's engine detection.
RUN apt-get update \
    && apt-get install --no-install-recommends -y openssl \
    && rm -rf /var/lib/apt/lists/*

# Manifests only, so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# The web workspace is declared in the root package.json, so npm resolves it even though this
# image does not build it. `--ignore-scripts` keeps postinstall hooks from running before source
# is present.
RUN npm ci --ignore-scripts

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api

# Contracts first: the API compiles against its emitted .d.ts files.
RUN npm run build -w @aics/contracts

WORKDIR /repo/apps/api
# `prisma generate` needs only the schema, never a connection — see the note in prisma.config.ts
# about why DATABASE_URL is deliberately absent from the build context.
RUN npx prisma generate && npx nest build

# Prune to production dependencies in place, so the runtime stage can copy a ready tree.
WORKDIR /repo
RUN npm prune --omit=dev

# npm workspaces hoist dependencies to the root, so a per-workspace node_modules exists only when
# there is a version conflict to resolve. `COPY` fails on a missing source, which would make the
# image build depend on whether hoisting happened to leave a directory behind. Guarantee it.
RUN mkdir -p /repo/apps/api/node_modules

# ---------- runtime ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /repo

RUN apt-get update \
    && apt-get install --no-install-recommends -y openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder /repo/packages/contracts/feature-set.v1.json ./packages/contracts/feature-set.v1.json

COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json
# Migrations and the schema travel with the image so `prisma migrate deploy` can run on release.
COPY --from=builder /repo/apps/api/prisma ./apps/api/prisma
COPY --from=builder /repo/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
# Credit policy is data, read at boot.
COPY --from=builder /repo/apps/api/policy ./apps/api/policy

WORKDIR /repo/apps/api

# Applicant documents. Owned by the app user so the non-root process can write.
RUN mkdir -p /data/storage \
    && useradd --create-home --shell /usr/sbin/nologin aics \
    && chown -R aics:aics /data/storage /repo/apps/api

USER aics

EXPOSE 4000

CMD ["node", "dist/src/main.js"]
