# ONE BNPL AICS — Credit Assessment Dashboard.

# ---------- builder ----------
FROM node:22-slim AS builder

WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci --ignore-scripts

COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web

RUN npm run build -w @aics/contracts

# Next inlines NEXT_PUBLIC_* into the client bundle at build time, so this is a build arg rather
# than a runtime variable. It is the URL the *browser* uses to reach the API, which is why it is
# `localhost:4000` and not the `api` service name — the browser is outside the compose network.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

WORKDIR /repo/apps/web
RUN npx next build

# ---------- runtime ----------
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /repo

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /repo/packages/contracts/package.json ./packages/contracts/package.json

COPY --from=builder /repo/apps/web/.next ./apps/web/.next
COPY --from=builder /repo/apps/web/public ./apps/web/public
COPY --from=builder /repo/apps/web/package.json ./apps/web/package.json
COPY --from=builder /repo/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=builder /repo/apps/web/node_modules ./apps/web/node_modules

WORKDIR /repo/apps/web

RUN useradd --create-home --shell /usr/sbin/nologin aics \
    && chown -R aics:aics /repo/apps/web/.next
USER aics

EXPOSE 3000

CMD ["npx", "next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
