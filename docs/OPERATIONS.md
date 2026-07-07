# Operations

Single group, single world, one VPS. Everything below assumes the repo is
checked out on the server and `stack/` is the working directory.

## First deploy

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
