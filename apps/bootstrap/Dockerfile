# Build context = repo root (workspace install needs the root lockfile).
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/bootstrap/package.json apps/bootstrap/
RUN pnpm install --frozen-lockfile --filter @companion/bootstrap... --prod

FROM node:22-alpine AS module
# Pinned REST module payload (VERSIONS.md: foundry-rest-api 3.4.1) baked at
# build time so the sidecar can pre-place it without network access.
ADD https://github.com/ThreeHats/foundryvtt-rest-api/releases/download/3.4.1/module.zip /tmp/module.zip
RUN apk add --no-cache unzip && mkdir -p /opt/foundry-rest-api && unzip -q /tmp/module.zip -d /opt/foundry-rest-api

FROM node:22-alpine
WORKDIR /repo
RUN corepack enable && apk add --no-cache wget su-exec && adduser -D -u 3000 companion
COPY --from=module /opt/foundry-rest-api /opt/foundry-rest-api
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/bootstrap/node_modules ./apps/bootstrap/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/bootstrap ./apps/bootstrap
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
COPY apps/bootstrap/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV RUNTIME_DIR=/run/companion STATUS_PORT=8321
EXPOSE 8321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8321/status.json || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /repo/apps/bootstrap
CMD ["npx", "tsx", "src/main.ts"]
