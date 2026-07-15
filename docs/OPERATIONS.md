# Operations

Single group, single world, one VPS. Everything below assumes the repo is
checked out on the server and `stack/` is the working directory.

## First deploy

0. **Turnkey path:** `make setup` (`docs/HOSTING.md` Part C) replaces steps
   2-6 below on a fresh server — self-mints the relay key, resolves the
   world's `clientId` automatically, no manual pairing in the happy path.
   Uses a separate compose file (`stack/quickstart/docker-compose.yml`); see
   the "Turnkey quickstart" checklist below before relying on it in
   production.
1. DNS: point `vtt.<domain>` and `app.<domain>` at the VPS; edit
   `stack/Caddyfile` with the real names.
2. `stack/.env`: foundryvtt.com credentials (only needed until the image has
   downloaded Foundry into `foundry-data/container_cache`), license key,
   admin key, plus `RELAY_API_KEY` / `RELAY_CLIENT_ID` (from step 5).
3. Build the PWA once on the server (or CI): `pnpm install && pnpm --filter
   @companion/web generate` → static files in `apps/web/.output/public`.
4. `docker compose -f docker-compose.prod.yml up -d foundry relay`.
5. One-time bridge setup (mirrors `docs/M0-findings.md`):
   - Relay account: `POST /auth/register`, then `POST /auth/api-keys`
     (scopes `entity:read, entity:write, search, events:subscribe,
     clients:read, dnd5e`) → `RELAY_API_KEY`.
   - In the world as GM: module settings → relay URL `wss://<relay-internal>`
     …for prod keep the module pointed at the relay through the docker
     network hostname exposed via Caddy or an SSH tunnel; approve pairing at
     the relay UI (`/pair/<CODE>`). Watch the auth rate limit (~20 req/15min):
     pair within ~15 s or restart the relay first.
   - `GET /clients` → `RELAY_CLIENT_ID` (`fvtt_…`).
   - Keep the world online headlessly: `POST /session-handshake` +
     `POST /start-session` (relay-managed GM browser), or leave a GM client
     connected.
6. `docker compose -f docker-compose.prod.yml up -d` (all services).
7. Generate invites (below), open `https://app.<domain>/join#<token>` on each
   player's phone.

## Invite tokens

- Create: `node scripts/make-invite.mjs <player> <actorId…>` → send the
  printed link over a private channel; append the printed YAML block to
  `apps/gateway/players.yaml`; `docker compose … restart gateway`.
- Rotate/revoke: delete the player's block (or replace with a fresh token's
  hash) in `players.yaml`, restart the gateway. Tokens are never stored
  server-side — only sha256 hashes.

## Backups

Everything stateful lives in three directories under `stack/`:

| path | contents | backup |
|---|---|---|
| `foundry-data/` | the world (LevelDB), systems, modules, config | nightly `tar` while Foundry is **stopped or idle**; Foundry's own backup UI (Manage Backups) also works |
| `relay-data/` | relay sqlite (accounts, API keys, pairings) | copy `data.db*` nightly |
| `apps/gateway/players.yaml` | player → actor mapping + token hashes | include in the same backup job |

Restore = stop stack, restore directories, start stack. The module's
connection token lives in the GM browser's localStorage — after a restore on
a fresh browser, re-pair (5 minutes, see M0 gotchas).

### Turnkey quickstart (`stack/quickstart/`)

Five host bind-mount folders next to `stack/quickstart/docker-compose.yml`
hold everything stateful:

| path | contents | backup |
|---|---|---|
| `foundry_data/` | the world, systems, modules, felddy's container cache | same as `foundry-data/` above |
| `relay-data/` | relay sqlite (accounts, keys, pairings) | same as `relay-data/` above |
| `gateway-data/` | `players.yaml` (player → actor mapping + token hashes) | same backup job |
| `caddy-data/` | Caddy's ACME state (TLS profile only) | regenerable (re-issues certs); backup optional |
| `companion-runtime/` | the sidecar's `relay.env` (minted key) + `status.json` | **regenerable — no backup needed**; the sidecar re-mints the key and re-derives status on next boot |
| `stack/quickstart/secrets/` | generated stack secrets: `foundry-config.json` (foundry.com creds + admin key), `bootstrap.env` (relay account + GM creds), `gateway.env` (admin console password) | **include in the same backup job** — these are only shown once by `make setup` and are not recoverable otherwise |

Restore = stop the stack (`docker compose down` from `stack/quickstart/`),
restore the folders above (`secrets/` and the four persistent data folders;
skip `companion-runtime/` — let it regenerate), start the stack again
(`docker compose up -d`).

### Turnkey quickstart — host verification checklist

The design deferred several checks to the operator's actual host (Ubuntu +
docker or rootless podman) because they couldn't be verified in the
implementation environment. See
`docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md` for the
full spike writeups. Confirm these on your host before treating the turnkey
path as production-hardened:

- **(a) Rootless podman parity (findings §3, spike c).** Not run in the dev
  environment (no podman host available there). On your Ubuntu + rootless
  podman host, verify: `env_file: { format: raw }` is honored (a `$` in a
  generated secret survives verbatim); the shared `companion-runtime` volume
  is readable across containers at mode `0600` (UID 3000); binding a port
  below 1024 fails until the `sysctl` from `docs/HOSTING.md` C1 is applied;
  and `grep -rn "docker.sock\|podman.sock" stack/` is empty (no
  container-runtime socket dependency anywhere). If the shared-volume read
  check fails, the documented fallback is to keep the bootstrap sidecar
  running as container-root (skip its `su-exec` drop to UID 3000) — harmless
  under rootless podman since container-root maps to your unprivileged host
  user.
- **(b) Fully-headless pairing (no browser at all).** Default is
  `HEADLESS_SELF_PAIR = false` (`apps/bootstrap/src/session.ts`) — a
  never-paired ("virgin") world falls back to the one-time guided browser
  pairing (`docs/HOSTING.md` C3) because bringing a virgin world online via
  `session-handshake`/`start-session` alone was **not** verified in the
  implementation environment (the available relay key lacked the
  `session:manage` scope — findings §1). To promote this to fully headless:
  with a correctly-scoped key (the sidecar already mints one with
  `session:manage`), create a virgin world, run the handshake + start-session
  sequence, and confirm the relay reports it `isOnline: true` with **every**
  browser closed for at least 60 seconds. If that passes, flip
  `HEADLESS_SELF_PAIR` to `true` in `apps/bootstrap/src/session.ts` and
  rebuild the bootstrap image.
- **(c) Admin-API world relaunch is off by default.** `relaunchWorldIfIdle`
  (`apps/bootstrap/src/foundry-admin.ts`) returns `'skipped'` unconditionally
  (`ADMIN_RELAUNCH = false`) — the HTTP recipe it contains (`POST /auth`
  `adminAuth` → `POST /setup` `launchWorld`) is the **expected** shape only,
  not a verified one (findings §2). Until it's verified and flipped on, use
  the documented `foundry_world` step instead (`docs/HOSTING.md` C4) so
  felddy relaunches the world itself on every boot.
- **(d) `foundry_data` ownership for module auto-placement.** The bootstrap
  sidecar (running as UID 3000) writes the pinned REST module into
  `foundry_data/Data/modules/foundry-rest-api` so you don't have to install
  it by hand (`apps/bootstrap/src/module-install.ts`). On Linux, felddy's
  Foundry container chowns `/data` to its own runtime UID, which can differ
  from 3000 — if it does, the sidecar's copy hits `EACCES` and silently
  reports `placement-failed` (retried every pass, never fatal — it does not
  block keeping the world online). If the module never shows up under
  Manage Modules, either make `foundry_data/Data` group/world-writable for
  UID 3000 on the host, or install the module by hand once (same zip as
  `VERSIONS.md`'s pinned release) — it's a one-time fix either way.

## Upgrades — honor VERSIONS.md

1. Never upgrade during a session week. Take a backup first.
2. Change ONE pin at a time in `VERSIONS.md` + compose/data dirs:
   - Foundry image tag / dnd5e zip / module zip / relay image.
   - Module and relay track each other — upgrade them together.
3. Verify: `pnpm test` (adapter fixture tests catch dnd5e path changes), then
   one live round-trip: read an actor via `/get`, change HP via the app,
   confirm it appears in Foundry, confirm a GM edit pushes to the app.
4. If dnd5e changes document shapes: re-capture fixtures
   (`docs/M0-findings.md` §1) and update `adapter-dnd5e`.

## Health

- `https://app.<domain>/api/healthz` → `{"ok":true,"relay":"connected"}`.
- Gateway logs: `docker compose … logs gateway` (structured JSON, tokens
  redacted). Relay activity: relay web UI → Activity Log.
- If players see stale data: check the world is online (`GET /clients`,
  `isOnline: true`) — the usual cause is the GM/headless session dropped.
- **Quickstart:** `http://<server>:8321` is the sidecar's read-only status
  page (phase + guidance, refreshes itself). The gateway's `GET /healthz`
  now also merges the sidecar's world/bootstrap state (phase, detail — never
  secrets or the `clientId`) into the same JSON response, so `/healthz` alone
  answers "why isn't my world online" without opening the status page.
