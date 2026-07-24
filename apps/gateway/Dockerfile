# Build context = repo root (workspace install needs the root lockfile).
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/adapter-sdk/package.json packages/adapter-sdk/
COPY packages/adapter-dnd5e/package.json packages/adapter-dnd5e/
COPY packages/adapter-wod5e/package.json packages/adapter-wod5e/
COPY packages/foundry-client/package.json packages/foundry-client/
RUN pnpm install --frozen-lockfile --filter @companion/gateway... --prod

FROM node:22-alpine
WORKDIR /repo
RUN corepack enable && apk add --no-cache wget
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/gateway/node_modules ./apps/gateway/node_modules
# adapter-dnd5e and adapter-wod5e each depend on adapter-sdk (workspace:*);
# pnpm's isolated linker resolves that via a symlink in each adapter's own
# node_modules, not the root one — so BOTH need copying (registry.ts imports
# both eagerly). adapter-sdk and foundry-client have no deps of their own, so
# they get no node_modules directory from pnpm and need no copy here.
COPY --from=deps /repo/packages/adapter-dnd5e/node_modules ./packages/adapter-dnd5e/node_modules
COPY --from=deps /repo/packages/adapter-wod5e/node_modules ./packages/adapter-wod5e/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/gateway ./apps/gateway
COPY packages ./packages
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
COPY apps/gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /repo/apps/gateway
CMD ["npx", "tsx", "src/server.ts"]
