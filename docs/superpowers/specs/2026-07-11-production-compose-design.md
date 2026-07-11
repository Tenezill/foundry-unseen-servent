# Production docker-compose — design

**Date:** 2026-07-11
**Status:** approved (brainstorm with user)
**Milestone:** M21 (working name: "one-command deploy")

## Problem

Running the companion today means: docker for Foundry+relay (dev compose),
plus a hand-started gateway (`tsx` + `.env`) and a hand-started web dev
server. HOSTING.md describes a production path (Caddy + built assets) but
nothing is composable — no one-command deployment exists.

## Goal

`docker compose up -d` from `stack/` brings up the whole application as
services. With the `foundry` profile enabled, that includes Foundry itself;
without it, the companion stack connects to an externally run Foundry.

## Decisions (user)

- **Both profiles:** one `stack/docker-compose.prod.yml`; `foundry` (and its
  relay pairing considerations) behind `--profile foundry`. Relay, gateway,
  and web are always-on services.
- **Build from source:** gateway and web images build from Dockerfiles in
  this repo (`docker compose build`); no registry publishing in v1 (ghcr is
  a later option). Foundry (`felddy/foundryvtt`) and relay
  (`threehats/foundryvtt-rest-api-relay`) stay pulled images, pinned to the
  versions the dev compose uses.

## Services

| Service | Image | Notes |
| --- | --- | --- |
| `foundry` (profile `foundry`) | `felddy/foundryvtt:13.351.0` | same env/volume shape as dev compose; user supplies license credentials via `.env` (format: raw — passwords may contain `$`) |
| `relay` | `threehats/foundryvtt-rest-api-relay:3.4.1` | sqlite volume, as dev |
| `gateway` | built: `apps/gateway/Dockerfile` | multi-stage: pnpm install workspace → run `tsx src/server.ts` or compiled dist; env from `stack/.env.gateway` (RELAY_*, PLAYERS_FILE, ADMIN_PASSWORD); `players.yaml` on a named volume/bind mount so hot-reload + admin console writes persist; healthcheck `GET /healthz` |
| `web` | built: `apps/web/Dockerfile` + Caddy | build stage runs `pnpm --filter @companion/web generate`; serve stage = `caddy:2` with a Caddyfile that serves the static output and reverse-proxies `/api/*` and `/healthz` to `gateway:8090` (same-origin — the PWA's `apiBase: ''` prod default) |

Networking: one compose network; the gateway reaches the relay at
`http://relay:3010`; with the foundry profile, the relay's paired session
targets `http://foundry:30000`. Only `web` (80/443) — and `foundry` (30000)
when profiled in — publish host ports by default; relay/gateway stay
internal (overridable for debugging).

## Constraints

- Do not break the dev compose or dev workflow; the prod file is additive.
  Shared bits (foundry/relay service definitions) may be factored via a
  compose `extends`/override only if it stays obvious — duplication is
  acceptable for clarity.
- The gateway container must start when `players.yaml` exists but be
  bootstrappable: document (and script via the image entrypoint) the
  idempotent `test -f || echo "players: []"` guard from the runbook.
- HTTPS: Caddy serves HTTP on the LAN by default; a commented Caddyfile
  block shows the domain + automatic-TLS variant. (PWA install prompts and
  clipboard APIs want HTTPS in real deployments — say so in docs.)
- Secrets live in git-ignored env files (`stack/.env`, `stack/.env.gateway`);
  ship `.example` twins.
- Windows + Linux hosts both work (no host-path tricks beyond what dev
  compose already does).

## Documentation impact

HOSTING.md gains the compose path as the recommended deployment ("Path C:
compose"), demoting manual steps to the fallback; LLM-SETUP-RUNBOOK.md's
infra phase points at the prod compose for non-dev installs. Pairing note:
first-run still requires the human GM pairing flow (runbook Phase 3 step 6)
— compose cannot automate the license EULA or the pairing click.

## Testing / verification

- `docker compose -f stack/docker-compose.prod.yml config` validates.
- Build both images locally; `up -d` without the foundry profile against the
  already-running dev Foundry+relay → PWA reachable via Caddy, `/api`
  same-origin proxy works, admin console works, a player token round-trips.
- With `--profile foundry` on a scratch volume: Foundry reaches its EULA
  screen (full world setup is the runbook's human path, not asserted here).
- No unit-test surface; this is infra — the verification IS the live pass.
