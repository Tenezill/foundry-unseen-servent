# Hosting & connecting Foundry's Unseen Servant

Two deployment shapes, described end to end:

- **A. Local** — everything on one machine (your PC), for testing or a LAN game.
- **B. Online** — one VPS with a real domain and HTTPS, for remote play.

Both use the same four pieces: **Foundry** (the game), the **relay**
(ThreeHats bridge), the **gateway** (our BFF), and the **web** PWA. The only
hard external dependency is a foundryvtt.com account + license key (to download
Foundry) and, for online, a domain name.

Pinned versions (see `VERSIONS.md`): Foundry `felddy/foundryvtt:13.351.0`,
dnd5e `5.3.3`, module `foundry-rest-api 3.4.1`,
relay `threehats/foundryvtt-rest-api-relay:3.4.1`.

```
[ Web PWA ] --HTTPS--> [ Gateway ] --REST/SSE--> [ Relay ] <==WS== [ Foundry + REST module ]
   phone browser         our code                 bridge          the module runs in a GM browser
```

The one non-obvious fact that drives everything: **the REST module runs inside
a logged-in GM browser session.** Something must keep a GM connected to the
world, or the relay reports the world offline and reads/writes 404. Locally
that's just a browser tab you leave open; online you use the relay's built-in
headless GM browser (Part B).

---

## Prerequisites (both)

- Docker Desktop (or Docker Engine + Compose v2).
- Node 22 + `pnpm` (`corepack enable && corepack prepare pnpm@11 --activate`)
  — only needed to run `scripts/make-invite.mjs`. The gateway and web app
  build as Docker images (`apps/gateway/Dockerfile`, `apps/web/Dockerfile`);
  `docker compose ... up -d --build` builds and runs both for you.
- A foundryvtt.com account and a **v13 license key**.
- The repo checked out.

---

## Part A — Local (LAN)

Uses `stack/docker-compose.prod.yml`: relay, gateway and web are always on;
Foundry sits behind `--profile foundry` — add that flag to have this same
compose run Foundry too (the normal case for a LAN game). Config lives in two
files: `stack/.env` (Foundry credentials) and `stack/.env.gateway` (relay key,
client id, admin password).

### A1. Configure secrets

```bash
cd stack
cp .env.example .env
cp .env.gateway.example .env.gateway
```

Edit `stack/.env`:

```
FOUNDRY_USERNAME=you@example.com
FOUNDRY_PASSWORD=your-foundry-password
FOUNDRY_LICENSE_KEY=XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
FOUNDRY_ADMIN_KEY=<any strong string — protects Foundry's /setup>
# Optional, once a world exists (A4): auto-launch it on every container
# start/restart, skipping the manual "Launch World" click:
# FOUNDRY_WORLD=<world-id>
```

The compose file reads this with `format: raw` so `$` in passwords is safe.
Both `.env` files are gitignored — they never leave your machine.
`stack/.env.gateway` starts empty; A6/A7/A8 below fill it in.

### A2. Bring up the stack

```bash
cd stack
docker compose -f docker-compose.prod.yml --profile foundry up -d --build
docker compose -f docker-compose.prod.yml logs -f foundry   # watch until "Server started and listening on port 30000"
```

This builds the gateway and web images and starts relay, gateway, web and
Foundry together. Foundry is on <http://localhost:30000>, the relay on
<http://localhost:3010>, and the PWA (via Caddy) on <http://localhost>.

The `gateway` container will show `Restarting` (crash-looping on missing
relay credentials) until `stack/.env.gateway` is filled in and the `up -d
gateway` recreate below (A8) runs — that's expected at this point, not a
broken install.

**Hostname pitfall:** the compose pins `hostname: foundry` on the Foundry
service — Foundry's license signature binds to the container hostname, so
changing or removing it re-prompts the license + EULA on the next recreate.
Leave it as-is.

### A3. Install the D&D 5e system + REST module

Fastest is to drop them straight into the data volume (no in-app browsing):

```bash
# from repo root, with the stack running
mkdir -p stack/foundry-data/Data/systems stack/foundry-data/Data/modules
# dnd5e 5.3.3
curl -L -o /tmp/dnd5e.zip https://github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/dnd5e-release-5.3.3.zip
unzip -o /tmp/dnd5e.zip -d stack/foundry-data/Data/systems/dnd5e
# REST API module 3.4.1
curl -L -o /tmp/restapi.zip https://github.com/ThreeHats/foundryvtt-rest-api/releases/download/3.4.1/module.zip
unzip -o /tmp/restapi.zip -d stack/foundry-data/Data/modules/foundry-rest-api
docker compose -f stack/docker-compose.prod.yml --profile foundry restart foundry
```

(Or install both from Foundry's own Setup UI — same result.)

### A4. First-run Foundry setup

Open <http://localhost:30000>:

1. Accept the EULA.
2. Enter the admin key from `FOUNDRY_ADMIN_KEY`.
3. **Create World** → system "Dungeons & Dragons Fifth Edition" → Launch it.
4. Join as **Gamemaster**.
5. Create your players (User Management) and their characters (Actors), and set
   each actor's **Ownership** so the right player owns it. Note each actor's id
   (the `Actor.<id>` in its sheet, or via the console `game.actors`).

### A5. Enable + point the REST module at the local relay

As GM, in the console (F12) or Module Settings:

- Enable the **Foundry REST API** module (Game Settings → Manage Modules).
- Set its **WebSocket Relay URL** to `ws://localhost:3010`
  (Module Settings → Foundry REST API → WebSocket Relay URL).
- Leave "Allow Execute JavaScript" / macro permissions **off** (default).

### A6. Create a relay account + scoped API key

The self-hosted relay has no default key. Create one via its API:

```bash
# 1. register an account (returns a sessionToken)
curl -s -X POST http://localhost:3010/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"gateway@companion.local","password":"choose-a-strong-one"}'

# 2. create a SCOPED key (paste the sessionToken from step 1)
curl -s -X POST http://localhost:3010/auth/api-keys \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <sessionToken>' \
  -d '{"name":"gateway","scopes":["entity:read","entity:write","search","events:subscribe","clients:read","dnd5e","roll:execute","chat:read","roll:read"]}'
```

Save the `key` from step 2 into `stack/.env.gateway` as **RELAY_API_KEY**. It
is shown once. (Those scopes cover reads, scoped writes, live push, the dnd5e
actions, dice rolling, and the GM roll feed.)

### A7. Pair the module to the relay

This links *this world* to your relay account. **Watch the rate limit:** the
relay throttles `/auth/*` to ~20 requests / 15 min per IP, and the module polls
while waiting — so do this quickly, or `docker compose restart relay` first to
reset the limiter.

1. In Foundry (GM), open the **REST API Connection** dialog (module button or
   `game.modules.get('foundry-rest-api').api.openConnectionDialog()`), click
   **Pair**. It shows a code and tries to open a browser tab.
2. The link it opens points at the **public** foundryrestapi.com — ignore it.
   Instead open **`http://localhost:3010/pair/<CODE>`** yourself.
3. Sign in with the account from A6, click **Approve Pairing**.
4. Back in Foundry the status flips to paired and a connection token is stored
   in that browser. Reloading the world reconnects automatically.

Confirm the world is online:

```bash
curl -s http://localhost:3010/clients -H "x-api-key: <RELAY_API_KEY>"
# -> {"clients":[{"clientId":"fvtt_....","isOnline":true, ...}]}
```

Save that `clientId` into `stack/.env.gateway` — this is your
**RELAY_CLIENT_ID**.

### A8. Finish configuring the gateway

Edit `stack/.env.gateway`:

```
RELAY_API_KEY=<from A6>
RELAY_CLIENT_ID=<from A7>
ADMIN_PASSWORD=<a strong password — enables the /admin invite console>
```

Then apply it:

```bash
docker compose -f docker-compose.prod.yml up -d gateway
```

`env_file` values are injected at container creation, so a plain `restart`
won't pick up your edits — `up -d` recreates the container when its config
changed.

`players.yaml` lives on the writable `stack/gateway-data/` volume
(`PLAYERS_FILE=/data/players.yaml` inside the container); the gateway image's
entrypoint bootstraps an empty `players: []` there on first start if it
doesn't exist yet, so there's nothing to create by hand.

### A9. Create invite tokens (and a GM token)

Either through the **admin console** (recommended): open
`http://localhost/admin`, log in with `ADMIN_PASSWORD`, **New player** per
player — searches actors by name, shows the one-time join link + QR code
once.

Or **scripted**, from the repo root:

```bash
node scripts/make-invite.mjs Anna kbXH9abc...
node scripts/make-invite.mjs Ben  aa3F2def...
```

Each run prints a one-time join link and a YAML block. Paste the blocks into
`stack/gateway-data/players.yaml`:

```yaml
players:
  - name: Anna
    tokenHash: "…"
    actorIds: ["kbXH9abc..."]
  - name: Ben
    tokenHash: "…"
    actorIds: ["aa3F2def..."]
  # a GM entry sees the world-wide roll feed; give it every actor it should also play:
  - name: Sebastian
    tokenHash: "…"
    actorIds: ["kbXH9abc...", "aa3F2def..."]
    gm: true
```

The file hot-reloads within ~1s — no restart needed either way. Give each
player their own link once; it stores the token in their browser. The console
has no GM toggle yet — hand-edit `gm: true` into that player's line.

### A10. Play, including on a phone over your LAN

Open <http://localhost> on your PC, then the join link, e.g.
`http://localhost/join#<token>`.

On a phone (same Wi-Fi): `http://<your-PC-LAN-IP>/join#<token>`. Caddy serves
the PWA and proxies `/api` same-origin on port 80 — no separate port for the
gateway. Keep the Foundry GM browser tab open so the world stays online (see
"Connecting to Foundry" below).

---

## Part B — Online (one VPS, HTTPS)

Uses `stack/docker-compose.prod.yml` + `stack/Caddyfile`. The Caddyfile ships
two variants: a LAN default (plain `:80`, what Part A uses) and a
commented-out public-HTTPS variant below it (Caddy provisions Let's Encrypt
certs for your domains automatically). Public surface is Caddy only:
`app.<domain>` → the PWA and its `/api` → gateway; `vtt.<domain>` → Foundry.
The gateway stays on the internal Docker network; the relay's `:3010` is
published by default (see B4b) — for a B4a-only (headless) deployment,
comment it out or bind it to localhost instead (see B4a).

### B1. DNS + enable the TLS variant

- Point `app.<domain>` and `vtt.<domain>` A-records at the VPS.
- Edit `stack/Caddyfile`: comment out (or delete) the `:80` block at the top,
  uncomment the "Public HTTPS variant" block below it, and replace its two
  example hostnames with your real domains.
- Edit `stack/docker-compose.prod.yml`: uncomment `- "443:443"` under the
  `web` service's `ports:`, and uncomment `FOUNDRY_PROXY_SSL=true` /
  `FOUNDRY_PROXY_PORT=443` under the `foundry` service's `environment:`.
- Create `stack/.env` and `stack/.env.gateway` exactly as in A1.

### B2. ~~Build the web app on the server~~ — no longer needed

`apps/web/Dockerfile` bakes `nuxt generate` into the Caddy image at build
time, so B3's `--build` does this for you. Nothing to build by hand.

### B3. Start everything + first-run

```bash
cd stack
docker compose -f docker-compose.prod.yml --profile foundry up -d --build
```

Do the Foundry first-run through `https://vtt.<domain>` (EULA, admin key,
install dnd5e + module as in A3, create the world/users/actors, enable the
module) — same as A3–A5. Same hostname pitfall as A2: don't change
`hostname: foundry` once the license is accepted, or the next recreate
re-prompts it. Once the world exists, set `FOUNDRY_WORLD=<world-id>` in
`stack/.env` so restarts relaunch it unattended (a GM browser session — B4
below — is still needed for the world to actually go online).

### B4. Connect the world to the relay — pick ONE

The module needs a live GM browser. Two ways:

**B4a. Relay headless GM session (recommended).** The relay image ships Chrome
+ Xvfb and can log into Foundry itself and hold the world online — so you
don't need a human browser connected. Since this deployment doesn't need the
relay reachable from outside, comment out the relay's `"3010:3010"` port
mapping in `stack/docker-compose.prod.yml` (or bind it to localhost instead:
`"127.0.0.1:3010:3010"`) — only B4b needs it public. Create the relay account
+ scoped key the same way as A6, reaching the relay over the Docker network
(e.g. `docker compose exec gateway curl ...`, or temporarily binding the port
to localhost as above), then lock it back down:

```
POST /session-handshake   headers: x-api-key, x-foundry-url: http://foundry:30000, x-username: <GM user>
POST /start-session       handshake token + the GM password  -> { sessionId, clientId }
```

Keep that session alive; `GET /clients` should show the world `isOnline: true`.
(These session endpoints exist in the relay; exercise them once on first deploy
and capture the exact payloads — treat like the pairing step in A7.)

**B4b. A human GM keeps a browser open.** The relay's `:3010` is already
published by the compose (`ports: "3010:3010"`), so point the module's Relay
URL straight at `ws://<vps-ip>:3010` and pair via
`http://<vps-ip>:3010/pair/<CODE>` — no Caddyfile edit required. For TLS,
add a `relay.<domain>` block instead (`reverse_proxy relay:3010`), set the
module's Relay URL to `wss://relay.<domain>`, and pair via
`https://relay.<domain>/pair/<CODE>`. Simpler than B4a, but needs a machine
with a GM tab always on.

Either way, note the `clientId` (`GET /clients`) → **RELAY_CLIENT_ID**.

### B5. Gateway env + secrets

Fill `stack/.env.gateway` (same as A8):

```
RELAY_API_KEY=<scoped key from B4>
RELAY_CLIENT_ID=<fvtt_... from B4>
ADMIN_PASSWORD=<a strong password — enables the /admin invite console>
```

```bash
docker compose -f docker-compose.prod.yml up -d gateway
```

Same as A8: `env_file` values are injected at container creation, so a plain
`restart` won't pick up your edits — `up -d` recreates the container instead.

`players.yaml` lives on the writable `stack/gateway-data/` volume, same as A8
— the gateway bootstraps it empty on first start.

### B6. Invite players

Same as A9: the admin console at `https://app.<domain>/admin`, or
`node scripts/make-invite.mjs …` + paste the YAML into
`stack/gateway-data/players.yaml` (hot-reloaded, no restart). Send each
player their `https://app.<domain>/join#<token>` link.

---

## Connecting to Foundry — the short version

"Connecting" = the REST module (in a GM browser or the relay's headless one)
opening an outbound WebSocket to the relay, then approving the pairing so the
relay knows which world your API key controls. The gateway never talks to
Foundry directly — only to the relay, using `RELAY_API_KEY` + `RELAY_CLIENT_ID`.

- **Local:** module Relay URL = `ws://localhost:3010`; pair at
  `http://localhost:3010/pair/<CODE>`.
- **Online, headless (B4a):** relay logs into `http://foundry:30000` itself;
  nothing to pair in a browser.
- **Online, human GM (B4b):** module Relay URL = `wss://relay.<domain>`; pair at
  `https://relay.<domain>/pair/<CODE>`.

Health check any time: `GET <gateway>/healthz` → `{"ok":true,"relay":"connected"}`,
and `GET <relay>/clients` (with the key) → world `isOnline: true`.

---

## Troubleshooting (things that actually bit us)

- **`/get` returns 404 / app shows "reconnecting":** no GM client is connected
  — the world is offline. Reopen the GM tab (local) or restart the headless
  session (online).
- **Pairing never completes / HTTP 429:** the relay auth rate limit tripped
  from the module's polling. `docker compose restart relay`, then pair within
  ~15 seconds.
- **Pair link opens foundryrestapi.com:** always replace the host with your own
  relay (`localhost:3010` or `relay.<domain>`).
- **Compose warns "variable is not set" / password mangled:** ensure the
  Foundry service uses `env_file: {path: .env, format: raw}` (already set) so
  `$` in the password isn't interpolated.
- **Foundry re-prompts the license/EULA after a routine restart:** the
  container's `hostname` changed. The compose pins `hostname: foundry` — the
  license signature binds to it; don't edit or remove that line.
- **dnd5e or module update breaks the sheet:** the adapter is pinned to dnd5e
  5.3.3; bump one pin at a time in `VERSIONS.md`, run `pnpm test`, then one live
  read/write round-trip. See `docs/OPERATIONS.md`.
- **Spell upcasting:** the relay casts at a spell's base level only — the app
  offers a single Cast and disables it when no base-level slot remains. Not a
  bug; a documented bridge limitation.
