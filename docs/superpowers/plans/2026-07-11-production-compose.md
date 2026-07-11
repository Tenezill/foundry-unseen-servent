# Production Compose (M21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose -f stack/docker-compose.prod.yml up -d --build` runs the whole application — relay + gateway + web always, Foundry behind `--profile foundry` — with images built from in-repo Dockerfiles.

**Architecture:** Modernize the existing M5-era `stack/docker-compose.prod.yml` + `stack/Caddyfile` (they exist but predate M13–M20): gateway and web become proper multi-stage images (pnpm workspace build), `players.yaml` moves to a writable directory volume (the current `:ro` single-file mount breaks M18's admin-console writes and FilePlayerStore's atomic rename), Foundry gets a compose profile, Caddy defaults to LAN HTTP with the TLS variant commented.

**Tech Stack:** Docker Compose, node:22-alpine + corepack (pnpm@11.10.0 per root `packageManager`), caddy:2.10, felddy/foundryvtt:13.351.0, threehats/foundryvtt-rest-api-relay:3.4.1.

**Spec:** `docs/superpowers/specs/2026-07-11-production-compose-design.md`

## Global Constraints

- The dev compose (`stack/docker-compose.dev.yml`) and dev workflow must keep working unchanged.
- `players.yaml` must be gateway-WRITABLE in the container (admin console + hot reload, M18): directory mount, never a single-file `:ro` bind. FilePlayerStore writes `.players.yaml.tmp` + rename in the same directory.
- Gateway container bootstraps a missing players.yaml idempotently (`test -f || echo "players: []" > …` — never overwrite an existing file; runbook rule).
- Secrets in git-ignored env files: `stack/.env` (Foundry, exists), new `stack/.env.gateway` (RELAY_API_KEY, RELAY_CLIENT_ID, ADMIN_PASSWORD). Ship `.example` twins; never commit real values.
- Only `web` (80, optional 443) — and `foundry` (30000) when the profile is active — publish host ports by default; relay and gateway stay internal (`expose` only).
- Foundry proxy vars (`FOUNDRY_PROXY_SSL/PORT`) must NOT be hardcoded on (LAN default is plain HTTP); the TLS deployment enables them via env/comments.
- pnpm version comes from corepack + the root `packageManager` field — do not hand-pin a different version in Dockerfiles.
- Build contexts are the repo root (workspace installs need root lockfile); a root `.dockerignore` must exclude `stack/foundry-data`, `stack/relay-data`, `stack/caddy-data`, `node_modules`, `.output`, `.git` (the foundry-data tree is multi-GB — without this every build ships it).
- Live verification runs on this machine against the real world data (details in Task 4); the dev stack is stopped for the duration and restarted afterwards.
- Commit after every task; end commit messages with:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Gateway image

**Files:**
- Create: `.dockerignore` (repo root)
- Create: `apps/gateway/Dockerfile`
- Create: `apps/gateway/docker-entrypoint.sh`

**Interfaces:**
- Produces (Task 3 relies on): image built with context `..` (repo root) and dockerfile `apps/gateway/Dockerfile`; listens on 8090; env contract: `PORT`, `RELAY_URL`, `RELAY_API_KEY`, `RELAY_CLIENT_ID`, `PLAYERS_FILE`, optional `ADMIN_PASSWORD`, optional `LOG_LEVEL`; expects `PLAYERS_FILE`'s parent directory to be a writable volume; `HEALTHCHECK` hits `/healthz`.

- [ ] **Step 1: Root `.dockerignore`**

```
.git
node_modules
**/node_modules
**/.output
**/dist
stack/foundry-data
stack/relay-data
stack/caddy-data
stack/gateway-data
.superpowers
.remember
docs
*.md
```

- [ ] **Step 2: `apps/gateway/Dockerfile`**

```dockerfile
# Build context = repo root (workspace install needs the root lockfile).
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/adapter-sdk/package.json packages/adapter-sdk/
COPY packages/adapter-dnd5e/package.json packages/adapter-dnd5e/
COPY packages/foundry-client/package.json packages/foundry-client/
RUN pnpm install --frozen-lockfile --filter @companion/gateway... --prod

FROM node:22-alpine
WORKDIR /repo
RUN corepack enable && apk add --no-cache wget
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/gateway ./apps/gateway
COPY packages ./packages
COPY apps/gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /repo/apps/gateway
CMD ["npx", "tsx", "src/server.ts"]
```

Notes for the implementer: the workspace packages are plain TS run via tsx (no build script exists — don't invent one). If `pnpm install --prod` omits `tsx` weirdness arises, remember tsx is a **prod** dependency of the gateway (see its package.json) so `--prod` keeps it. If the `--filter ... --prod` two-stage copy fights pnpm's symlink layout, the acceptable fallback is a single-stage image that runs `pnpm install --frozen-lockfile --filter @companion/gateway... --prod` directly — correctness over image-size elegance; note whichever you shipped in the report.

- [ ] **Step 3: `apps/gateway/docker-entrypoint.sh`**

```sh
#!/bin/sh
set -e
# Idempotent players.yaml bootstrap: never overwrite a live install's hashes.
if [ -n "$PLAYERS_FILE" ] && [ ! -f "$PLAYERS_FILE" ]; then
  mkdir -p "$(dirname "$PLAYERS_FILE")"
  echo "players: []" > "$PLAYERS_FILE"
  echo "bootstrapped empty players file at $PLAYERS_FILE"
fi
exec "$@"
```

(LF line endings — add a `.gitattributes` line `*.sh text eol=lf` if the repo doesn't force it; a CRLF entrypoint dies with `not found` on alpine.)

- [ ] **Step 4: Build + smoke**

Run from repo root:
`docker build -f apps/gateway/Dockerfile -t companion-gateway:dev .`
Expected: image builds. Smoke (no relay needed — it should fail cleanly on missing env, proving the entrypoint + tsx wiring):
`docker run --rm -e PLAYERS_FILE=/data/players.yaml -v companion_gw_smoke:/data companion-gateway:dev` → expect the bootstrap log line then `gateway failed to start: missing required env var RELAY_URL` and exit. Clean up the throwaway volume.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore apps/gateway/Dockerfile apps/gateway/docker-entrypoint.sh .gitattributes
git commit -m "feat(deploy): gateway Dockerfile with players.yaml bootstrap entrypoint"
```

---

### Task 2: Web image

**Files:**
- Create: `apps/web/Dockerfile`

**Interfaces:**
- Produces (Task 3 relies on): image built with context repo root, dockerfile `apps/web/Dockerfile`; a caddy:2.10 image with the generated PWA baked into `/srv/app`; the Caddyfile itself is NOT baked in (compose bind-mounts `stack/Caddyfile`).

- [ ] **Step 1: `apps/web/Dockerfile`**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/adapter-sdk/package.json packages/adapter-sdk/
RUN pnpm install --frozen-lockfile --filter @companion/web...
COPY apps/web ./apps/web
COPY packages/adapter-sdk ./packages/adapter-sdk
RUN pnpm --filter @companion/web generate

FROM caddy:2.10
COPY --from=build /repo/apps/web/.output/public /srv/app
```

Check first which workspace packages `@companion/web` actually depends on (its package.json / imports — it types against `@companion/adapter-sdk`; copy exactly the set needed, no more). If generate needs more of the workspace than expected, widen the COPY set and note it.

- [ ] **Step 2: Build + smoke**

`docker build -f apps/web/Dockerfile -t companion-web:dev .`
Then: `docker run --rm -p 8099:80 -v F:\private\foundry-comanion\stack\Caddyfile.smoke:/etc/caddy/Caddyfile:ro companion-web:dev` won't work without a matching Caddyfile — simpler smoke: run with caddy's file-server one-liner:
`docker run --rm -p 8099:8099 companion-web:dev caddy file-server --root /srv/app --listen :8099` → `curl http://localhost:8099/` returns the PWA's index.html (contains "Foundry's Unseen Servant"). Ctrl-C / stop.

- [ ] **Step 3: Commit**

```bash
git add apps/web/Dockerfile
git commit -m "feat(deploy): web Dockerfile — nuxt generate baked into caddy image"
```

---

### Task 3: Compose + Caddyfile + env examples

**Files:**
- Modify: `stack/docker-compose.prod.yml` (full rewrite; current content is M5-era)
- Modify: `stack/Caddyfile` (LAN-first rewrite)
- Create: `stack/.env.gateway.example`
- Modify: `stack/.gitignore` or root `.gitignore` (ensure `stack/.env.gateway`, `stack/gateway-data/`, `stack/caddy-data/` ignored — check what's already covered)

**Interfaces:**
- Consumes: the two images from Tasks 1–2 (build contexts/dockerfiles as specified there).
- Produces: the deployable artifact. Profile contract: `--profile foundry` adds Foundry; without it, relay pairing targets an external Foundry.

- [ ] **Step 1: Rewrite `stack/docker-compose.prod.yml`**

```yaml
name: foundrys-unseen-servant

# Production stack (M21). One command:
#   docker compose -f docker-compose.prod.yml up -d --build
# Add Foundry itself (license credentials in .env) with:
#   docker compose -f docker-compose.prod.yml --profile foundry up -d --build
#
# Public surface: web (Caddy) on 80 — and Foundry on 30000 when profiled in.
# Relay and gateway stay on the internal network.
# Config: .env (Foundry, only with the profile) + .env.gateway (see example).

services:
  web:
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
    ports:
      - "80:80"
      # - "443:443"   # uncomment with the TLS Caddyfile variant
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
    restart: unless-stopped
    depends_on:
      - gateway

  gateway:
    build:
      context: ..
      dockerfile: apps/gateway/Dockerfile
    env_file:
      - .env.gateway
    environment:
      - PORT=8090
      - RELAY_URL=http://relay:3010
      - PLAYERS_FILE=/data/players.yaml
    expose:
      - "8090"
    volumes:
      - ./gateway-data:/data
    restart: unless-stopped
    depends_on:
      - relay

  relay:
    image: threehats/foundryvtt-rest-api-relay:3.4.1
    environment:
      - APP_ENV=production
      - PORT=3010
      - DB_TYPE=sqlite
    expose:
      - "3010"
    ports:
      - "3010:3010"   # the Foundry module (GM browser) connects via ws://<host>:3010
    volumes:
      - ./relay-data:/app/data
    restart: unless-stopped

  foundry:
    profiles: ["foundry"]
    image: felddy/foundryvtt:13.351.0
    env_file:
      - path: .env
        format: raw
    environment:
      - TIMEZONE=Europe/Vienna
      - FOUNDRY_MINIFY_STATIC_FILES=true
      # For a TLS deployment behind Caddy, also set:
      # - FOUNDRY_PROXY_SSL=true
      # - FOUNDRY_PROXY_PORT=443
    ports:
      - "30000:30000"
    volumes:
      - ./foundry-data:/data
    restart: unless-stopped
```

Decisions locked in the yaml (keep them): Caddy must NOT `depends_on: foundry` (breaks profile-less runs); the relay's 3010 must be published (the GM browser's module opens a WebSocket to it from outside the compose network — the M5 file got this wrong for the B4b flow, and LAN mode needs it unconditionally); Foundry proxy vars are comments, not defaults.

- [ ] **Step 2: Rewrite `stack/Caddyfile`**

```
# LAN default: plain HTTP on :80 — the PWA and its /api, same-origin.
# For public HTTPS, comment this block and use the domain variant below.

:80 {
	handle /api/* {
		reverse_proxy gateway:8090
	}
	handle /healthz {
		reverse_proxy gateway:8090
	}
	handle {
		root * /srv/app
		try_files {path} /index.html
		file_server
	}
	encode gzip
}

# --- Public HTTPS variant (automatic Let's Encrypt) -------------------------
# app.example.com {
# 	handle /api/* {
# 		reverse_proxy gateway:8090
# 	}
# 	handle /healthz {
# 		reverse_proxy gateway:8090
# 	}
# 	handle {
# 		root * /srv/app
# 		try_files {path} /index.html
# 		file_server
# 	}
# 	encode gzip
# }
# vtt.example.com {
# 	reverse_proxy foundry:30000
# }
```

- [ ] **Step 3: `stack/.env.gateway.example`**

```
# Relay credentials — mint on the relay account that owns the world pairing
# (see docs/LLM-SETUP-RUNBOOK.md Phase 4).
RELAY_API_KEY=
RELAY_CLIENT_ID=
# Enables the /admin invite console. Leave empty to disable it entirely.
ADMIN_PASSWORD=
# Optional: pino level (default info)
# LOG_LEVEL=info
```

- [ ] **Step 4: gitignore coverage**

Check existing ignore rules for `stack/.env` (it's already untracked); add whatever's missing so `stack/.env.gateway`, `stack/gateway-data/`, `stack/caddy-data/` never get committed.

- [ ] **Step 5: Validate**

`docker compose -f stack/docker-compose.prod.yml config` → valid, no foundry service listed.
`docker compose -f stack/docker-compose.prod.yml --profile foundry config` → foundry included.
(Create `stack/.env.gateway` locally from the example with the real values from `apps/gateway/.env` for the later live pass — do not commit it.)

- [ ] **Step 6: Commit**

```bash
git add stack/docker-compose.prod.yml stack/Caddyfile stack/.env.gateway.example .gitignore
git commit -m "feat(deploy): production compose — profiles, built images, writable players volume"
```

---

### Task 4: Live verification (coordinator-led, this machine)

The dev stack currently runs the same volumes (`stack/foundry-data`, `stack/relay-data`). Full-fidelity check = swap stacks on the SAME data:

- [ ] 1. Seed `stack/gateway-data/players.yaml` from `apps/gateway/players.yaml` (copy — keeps existing invites working in the prod stack).
- [ ] 2. Stop dev services + host processes that collide: `docker compose -f stack/docker-compose.dev.yml down` and stop the host gateway (port 8090). The Nuxt dev server (3001) can stay.
- [ ] 3. `docker compose -f stack/docker-compose.prod.yml --profile foundry up -d --build` (LAN mode).
- [ ] 4. Checklist:
   - Foundry reachable at `http://localhost:30000`, world resumable; GM browser tab reconnects the module's relay WS (`ws://localhost:3010` — unchanged URL, same relay-data, pairing persists).
   - `http://localhost/` serves the PWA via Caddy; join with the existing invite token (`…/join#…`) — same-origin `/api` works end to end (sheet loads LIVE).
   - Admin console at `http://localhost/admin` logs in (ADMIN_PASSWORD from .env.gateway) and CAN CREATE a throwaway player — proving the players.yaml volume is writable (the M5 file's `:ro` mount would have failed here); revoke it after.
   - One action roll from the PWA (proves gateway→relay→Foundry round trip).
   - `docker compose ps` shows the gateway healthy (healthcheck green).
- [ ] 5. Tear down (`down`), restart the dev stack (`docker compose -f stack/docker-compose.dev.yml up -d`), restart the host gateway, confirm dev-mode PWA works again.
- [ ] 6. Record results in the ledger.

---

### Task 5: Docs

**Files:**
- Modify: `docs/HOSTING.md` (compose-first rewrite of Parts A/B: LAN = prod compose without TLS comments; VPS = enable TLS variant + Foundry proxy vars; manual host-build path demoted to an appendix note or deleted where the compose supersedes it — keep the pairing/session explanations, they're still true)
- Modify: `docs/LLM-SETUP-RUNBOOK.md` (infra phase: point non-dev installs at the prod compose; note `.env.gateway`; the players.yaml bootstrap now also happens automatically in the container entrypoint)

- [ ] Update both docs; commit:

```bash
git add docs/HOSTING.md docs/LLM-SETUP-RUNBOOK.md
git commit -m "docs: compose-first hosting guide (M21)"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** both profiles → Task 3 (profiles key, no caddy→foundry depends_on); build from source → Tasks 1–2; writable players.yaml + bootstrap → Task 1 entrypoint + Task 3 volume (fixes the M5 `:ro` latent bug); ADMIN_PASSWORD env → Task 3 env file; healthcheck → Task 1; LAN HTTP default + TLS variant → Task 3 Caddyfile; only web/foundry publish ports → Task 3 (relay 3010 published deliberately — spec said "internal" but the GM-browser WebSocket architecture requires reachability; recorded as a spec deviation with reason, revisit only for the headless-session variant); secrets via env examples → Task 3; dev compose untouched → all tasks additive except the prod file itself; verification → Task 4; docs → Task 5.
- **Placeholder scan:** clean; the two "check first/if fights pnpm layout" notes name concrete fallbacks.
- **Type consistency:** env names match `apps/gateway/src/config.ts` (`PORT`, `RELAY_URL`, `RELAY_API_KEY`, `RELAY_CLIENT_ID`, `PLAYERS_FILE`, `ADMIN_PASSWORD`, `LOG_LEVEL`); ports 8090/3010/30000/80 consistent across Dockerfiles, compose, Caddyfile.
