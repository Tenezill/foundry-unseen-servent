# Build context = repo root (workspace install needs the root lockfile).
#
# @companion/web has no workspace-package runtime dependency: its only
# `@companion/adapter-sdk` references are `import type { ... }` (type-only)
# resolved via a tsconfig path alias in nuxt.config.ts for editor/typecheck
# support. Nuxt's Vite build strips `import type` at parse time without
# resolving the module, and `nuxt generate` here does not run type-checking.
# So no packages/* need to be copied into this build stage — see
# pnpm-lock.yaml's `apps/web` importer, which lists no @companion/* deps.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
# nuxt (and other build-time tooling) are devDependencies, so no --prod here.
RUN pnpm install --frozen-lockfile --filter @companion/web...
COPY apps/web ./apps/web
RUN pnpm --filter @companion/web generate

FROM caddy:2.10
COPY --from=build /repo/apps/web/.output/public /srv/app
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
