# Hosting & connecting Foundry's Unseen Servant

Three deployment shapes, described end to end:

- **A. Local** — everything on one machine (your PC), for testing or a LAN game.
- **B. Online** — one VPS with a real domain and HTTPS, for remote play.
- **C. Turnkey** — one command (`make setup`) on a server with docker or
  rootless podman; the stack self-wires (mints its own relay key, resolves
  the world automatically) so there's no manual relay pairing or key
  juggling in the happy path. See Part C below.

All three use the same four pieces: **Foundry** (the game), the **relay**
(ThreeHats bridge), the **gateway** (our BFF), and the **web** PWA. Part C adds
a fifth, small piece — a **bootstrap sidecar** — that does the relay
account/key/pairing work for you. The only hard external dependency is a
foundryvtt.com account + license key (to download Foundry) and, for online (B)
or remote players (C's TLS profile), a domain name.

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

## Prerequisites (Parts A & B)

Part C (turnkey) has its own, shorter prerequisite list — see C1.

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
(e.g. `docker compose exec gateway wget -qO- ...` — the gateway image ships
wget, not curl — or temporarily binding the port to localhost as above), then
lock it back down:

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

## Part C — Turnkey quickstart (docker or rootless podman)

Uses `stack/quickstart/docker-compose.yml`, a separate compose file from A/B
(don't run it on the same host as `stack/docker-compose.prod.yml` without
changing its ports — see C1). One `make setup` on a server: no manual relay
pairing, no key juggling. A **bootstrap sidecar** (`apps/bootstrap`) registers
the relay account, mints the gateway's API key at runtime and hands it to the
gateway over a shared volume (the gateway hot-reloads it and resolves the
world's `clientId` itself — `RELAY_CLIENT_ID=auto`), pre-installs the REST
module into the Foundry data dir, and keeps your world online. You bring your
own world — no demo content ships.

### C1. Prerequisites

- A server (Ubuntu or similar) with **docker + Compose v2** OR **rootless
  podman ≥4** — either is auto-detected by `make setup`.
- **Node 22** to run `make setup` and `scripts/make-invite.mjs` (plain Node
  scripts on the host, no `pnpm` needed for this path — `compose ... --build`
  builds the `bootstrap`, `gateway` and `web` images; `foundry` and `relay`
  are pulled, not built).
- A foundryvtt.com account with a **v13 license**. Nothing else.
- The repo checked out.
- Don't run this next to the A/B dev/prod stack on the same host without
  changing the `HOST_PORT_*` variables in `stack/quickstart/.env` first —
  the defaults (30000, 3010, 8080, 8321) collide with A/B's.
- **Rootless podman:** the default web port is **8080**, not 80 (rootless
  podman can't bind ports below 1024). If you opt into the TLS profile (C5),
  which needs 80/443, first run
  `sudo sysctl net.ipv4.ip_unprivileged_port_start=80` on the host.

### C2. Setup

```bash
make setup
```

(`Makefile` just runs `node scripts/setup-quickstart.mjs`.) It prompts for the
minimum: your foundry.com username/password, license key (Enter = fetch it
from the account), and — only if you want HTTPS — "Enable HTTPS on your own
domain? [y/N]", then the app domain, the Foundry domain, and an email for
Let's Encrypt. Everything else is **generated** and printed **once**:

- the Foundry **admin key** (for the Foundry setup screen),
- the **Gamemaster password** (set it on the Gamemaster user in your world),
- the relay account password (account email is fixed:
  `bootstrap@companion.local`),
- the app **admin console password** (`/admin`, for invites).

These are written to `stack/quickstart/secrets/*.env` and
`secrets/foundry-config.json` (mode `0600`) — nothing else is typed, and
nothing else needs editing. `make setup` finishes by auto-detecting your
runtime and running `docker compose up -d --build` (or `podman compose` /
`podman-compose`) for you.

#### Rootless-Podman file ownership

On the Podman path, `make setup` also writes
`stack/quickstart/docker-compose.override.yml` giving the `foundry` service
`userns_mode: "keep-id"`. This is required because felddy runs as a fixed
non-root uid, which under rootless Podman cannot read the host-owned
`foundry_data` bind mount or the `0600` `secrets/foundry-config.json`. `keep-id`
maps foundry's uid to your host user, so both work — and you keep read access to
your own admin key. The override is **not** applied on Docker (unnecessary
there, and auto-removed if you switch to Docker). Only `foundry` gets it:
`relay`, `gateway`, `web`, and `bootstrap` run as root (or start as root and
self-chown), which already maps to the host user under rootless Podman. The file
is generated (git-ignored) and wiped by `make setup-reset`.

Re-running `make setup` is safe: existing secrets are kept and never
re-shown. `make setup-reset` deletes the generated `.env`, `Caddyfile.tls` and
`secrets/*` (after a y/N confirmation) so you can start over — the bind-mount
data folders (C4) are untouched.

### C3. First run — bring your own world

Watch the status page at `http://<server>:8321` — it tells you which phase
the sidecar is in and what to do next (see C5 for the phase list). Then, on
`http://<server>:30000` (or `https://<vtt-domain>` if you set up TLS):

1. Accept the EULA (still a one-time manual UI step even with the
   credentials file — Foundry doesn't expose an API for it) and enter the
   admin key `make setup` printed.
2. Install your game system, **Create World**, and join it as **Gamemaster**.
3. In User Management, set the **Gamemaster** user's password to the
   generated Gamemaster password from C2.
4. Enable the **Foundry REST API** module (Manage Modules) — the sidecar
   already placed it in `Data/modules` for you, so there's nothing to
   download. Then, in the module's settings, set **WebSocket Relay URL** to
   `ws://<server-LAN-IP>:3010` — **use the LAN IP of the server, not
   `localhost`**, unless the browser you're doing this from is running on
   the server itself (the module runs inside whichever browser has the
   world open). The module appends `/relay` itself, so
   `ws://<ip>:3010` and `ws://<ip>:3010/relay` both work.
5. Launch (or stay in) the world.

From here the sidecar takes over. **Current default** (`HEADLESS_SELF_PAIR =
false` — a virgin, never-paired world could not be verified to self-pair
headlessly in this environment; see the Task 0 findings §1): the status page
switches to **needs-pairing** and asks for a **one-time browser pairing** —
open the REST API Connection dialog in the world (as GM), click **Pair**, then
visit `http://<server>:3010/pair/<CODE>` yourself and approve it with the
relay account (`bootstrap@companion.local` + the password from C2). After
that one-time step (and automatically, if `HEADLESS_SELF_PAIR` is later
verified and flipped to `true` on your host — see `docs/OPERATIONS.md`), the
sidecar's converge loop keeps re-establishing the relay session on its own —
no browser tab needs to stay open.

If the status page shows **gm-login-failed**: the Gamemaster user's password
in the world doesn't match `FOUNDRY_GM_PASSWORD` in
`stack/quickstart/secrets/bootstrap.env` — redo step 3 above.

### C4. Survive a restart (read this before you reboot)

All state lives in **host bind-mount folders** next to
`stack/quickstart/docker-compose.yml`: `./foundry_data`, `./relay-data`,
`./gateway-data`, `./caddy-data`, `./companion-runtime`. Those, plus every
service's `restart: unless-stopped`, mean the containers themselves come back
after a reboot — **but Foundry does not relaunch your world by itself.**

felddy's Foundry image only auto-launches a world at boot when
`foundry_world` (or `FOUNDRY_WORLD`) is set — and the quickstart can't
pre-set it, because there's no world before you create one. The sidecar's
admin-API auto-relaunch is deliberately off by default (unverified —
`ADMIN_RELAUNCH = false` in `apps/bootstrap/src/foundry-admin.ts`; see the
Task 0 findings §2), so **without the step below, a reboot leaves Foundry at
the setup screen and the sidecar has no running world to bring online.**

Do this once, after you've created your world (C3):

- Add `"foundry_world": "<your-world-id>"` to
  `stack/quickstart/secrets/foundry-config.json` (the world id/folder name
  under `Data/worlds/`), then restart the `foundry` container
  (`docker compose restart foundry` from `stack/quickstart/` — it's a
  bind-mounted file, so a restart re-reads it; no rebuild needed) so it
  picks up the change.

With that set, the stack survives a reboot end to end: Foundry relaunches the
world, the sidecar's converge loop re-establishes the relay session (or, if
still on the pairing fallback, the once-paired browser connection tokens
still work once you reopen a GM tab), and the gateway re-resolves the
`clientId` automatically.

### C5. Status page and health

- `http://<server>:8321` — read-only, LAN-bound, refreshes itself every 5s.
  Never shows secrets. Phases (`apps/bootstrap/src/status.ts`): `starting` →
  `waiting-relay` → `provisioning-account` → `minting-key` → `key-ready` →
  `placing-module` → **`waiting-world`** (open Foundry and follow C3) →
  `starting-session` → **`online`**, with **`gm-login-failed`** and
  **`needs-pairing`** as the two "operator action needed" side branches, and
  `error` for anything else (retried automatically).
- The gateway's `GET /healthz` merges the same phase/detail (whitelisted —
  never the relay key or `clientId`) alongside its own relay-reachability
  probe, so you can check status from one place even without opening the
  status page.

### C6. Invite players

Same tooling as A9/B6, unchanged: the admin console at
`http://<server>:8080/admin` (or `https://app.<domain>/admin` with TLS), log
in with the admin password from C2, **New player**. Or script it:
`node scripts/make-invite.mjs <name> <actorId…>` and paste the printed YAML
into `stack/quickstart/gateway-data/players.yaml` (hot-reloaded). Players
open `https://app.<domain>/join#<token>` (TLS) or
`http://<server>:8080/join#<token>` (plain HTTP).

### C7. HTTPS for remote players (opt-in)

Answer "y" to the HTTPS prompt during `make setup` (or `make setup-reset` and
run it again). Point both domains' DNS A-records at the server first; `make
setup` writes `stack/quickstart/Caddyfile.tls` from your answers and sets
`COMPOSE_PROFILES=tls` in `.env`, which starts an extra `web-tls` service
(Caddy with automatic Let's Encrypt certs) on 80/443 **alongside** the plain
`web` service on 8080 — the plain-HTTP port stays up too (handy for LAN play
while remote players use the domain). Rootless podman needs the `sysctl` from
C1 to bind 80/443. Note: over plain HTTP on a LAN IP the PWA loses
installability/offline support (browsers require a secure context for that)
— this only affects the plain-HTTP path; remote players should always be
given the TLS domain link.

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
