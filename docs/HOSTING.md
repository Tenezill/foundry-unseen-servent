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
  — only needed on whatever machine *builds* the web app and runs the gateway.
  Online, the compose file builds the gateway in a Node container for you.
- A foundryvtt.com account and a **v13 license key**.
- The repo checked out.

---

## Part A — Local

### A1. Configure secrets

```bash
cd stack
cp .env.example .env
```

Edit `stack/.env`:

```
FOUNDRY_USERNAME=you@example.com
FOUNDRY_PASSWORD=your-foundry-password
FOUNDRY_LICENSE_KEY=XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
FOUNDRY_ADMIN_KEY=<any strong string — protects Foundry's /setup>
```

The compose file reads this with `format: raw` so `$` in passwords is safe.
`stack/.env` is gitignored — it never leaves your machine.

### A2. Bring up Foundry + relay

```bash
cd stack
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f foundry   # watch until "Server started and listening on port 30000"
```

Foundry is now on <http://localhost:30000>, the relay on <http://localhost:3010>.

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
docker compose -f stack/docker-compose.dev.yml restart foundry
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

Save the `key` from step 2 — this is your **RELAY_API_KEY**. It is shown once.
(Those scopes cover reads, scoped writes, live push, the dnd5e actions, dice
rolling, and the GM roll feed.)

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

Save that `clientId` — this is your **RELAY_CLIENT_ID**.

### A8. Configure + run the gateway

```bash
cd apps/gateway
cp .env.example .env 2>/dev/null || true   # or create it
```

`apps/gateway/.env`:

```
PORT=8090
RELAY_URL=http://localhost:3010
RELAY_API_KEY=<from A6>
RELAY_CLIENT_ID=<from A7>
PLAYERS_FILE=./players.yaml
```

### A9. Create invite tokens (and a GM token)

```bash
# from repo root, one per player:  node scripts/make-invite.mjs <name> <actorId...>
node scripts/make-invite.mjs Anna kbXH9abc...
node scripts/make-invite.mjs Ben  aa3F2def...
```

Each run prints a one-time join link and a YAML block. Paste the blocks into
`apps/gateway/players.yaml`:

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

Give each player their own link once; it stores the token in their browser.

### A10. Run the gateway and the web app

```bash
# gateway (from apps/gateway, with its .env exported or via a tool that loads .env)
pnpm --filter @companion/gateway start

# web (from repo root) — dev server:
pnpm --filter @companion/web dev
# or a production build served statically:
pnpm --filter @companion/web generate   # output in apps/web/.output/public
```

`nuxt dev` proxies `/api` to the gateway on :8090. Open the printed URL
(e.g. <http://localhost:3001>) then visit the join link, e.g.
`http://localhost:3001/join#<token>`.

### A11. Play on a real phone over your LAN

```bash
pnpm --filter @companion/web dev --host
```

On the phone (same Wi-Fi), open `http://<your-PC-LAN-IP>:3001/join#<token>`.
Keep the Foundry GM tab open on your PC so the world stays online.

---

## Part B — Online (one VPS, HTTPS)

Uses `stack/docker-compose.prod.yml` + `stack/Caddyfile` (Caddy terminates TLS
via Let's Encrypt automatically). Public surface is Caddy only:
`vtt.<domain>` → Foundry, `app.<domain>` → the PWA and its `/api` → gateway.
The relay stays on the internal Docker network.

### B1. DNS + files

- Point `vtt.<domain>` and `app.<domain>` A-records at the VPS.
- Edit `stack/Caddyfile`, replacing the two example hostnames.
- Create `stack/.env` exactly as in A1 (add `FOUNDRY_PROXY_SSL=true` is already
  set in the prod compose).

### B2. Build the web app on the server

```bash
pnpm install
pnpm --filter @companion/web generate   # Caddy serves apps/web/.output/public
```

### B3. Start Foundry + relay, do first-run

```bash
cd stack
docker compose -f docker-compose.prod.yml up -d foundry relay
```

Do the Foundry first-run through `https://vtt.<domain>` (EULA, admin key,
install dnd5e + module as in A3, create the world/users/actors, enable the
module). This is the same as A3–A5.

### B4. Connect the world to the relay — pick ONE

The module needs a live GM browser. Two ways:

**B4a. Relay headless GM session (recommended).** The relay image ships Chrome
+ Xvfb and can log into Foundry itself and hold the world online — so the relay
stays internal and you don't need a human browser connected. After creating the
relay account + scoped key (same as A6, against the relay — reach it with a
temporary `docker compose exec` or a one-off published port, then close it):

```
POST /session-handshake   headers: x-api-key, x-foundry-url: http://foundry:30000, x-username: <GM user>
POST /start-session       handshake token + the GM password  -> { sessionId, clientId }
```

Keep that session alive; `GET /clients` should show the world `isOnline: true`.
(These session endpoints exist in the relay; exercise them once on first deploy
and capture the exact payloads — treat like the pairing step in A7.)

**B4b. A human GM keeps a browser open.** Then the relay's WebSocket must be
publicly reachable: add a `relay.<domain>` block to the Caddyfile
(`reverse_proxy relay:3010`), set the module's Relay URL to
`wss://relay.<domain>`, and pair via `https://relay.<domain>/pair/<CODE>`.
Simpler, but it exposes the relay and needs a machine with a GM tab always on.

Either way, note the `clientId` (`GET /clients`) → **RELAY_CLIENT_ID**.

### B5. Gateway env + secrets

The prod compose runs the gateway in a Node container. Provide, via the VPS
shell environment (or a root `.env` compose reads):

```
RELAY_API_KEY=<scoped key>
RELAY_CLIENT_ID=<fvtt_...>
```

Mount your real `apps/gateway/players.yaml` (it's gitignored) with player
entries + a `gm: true` entry, as in A9.

### B6. Launch everything + invite

```bash
cd stack
docker compose -f docker-compose.prod.yml up -d
```

Generate invite links with `node scripts/make-invite.mjs …`, add the YAML to
`players.yaml`, `docker compose … restart gateway`, and send each player their
`https://app.<domain>/join#<token>` link.

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
- **dnd5e or module update breaks the sheet:** the adapter is pinned to dnd5e
  5.3.3; bump one pin at a time in `VERSIONS.md`, run `pnpm test`, then one live
  read/write round-trip. See `docs/OPERATIONS.md`.
- **Spell upcasting:** the relay casts at a spell's base level only — the app
  offers a single Cast and disables it when no base-level slot remains. Not a
  bug; a documented bridge limitation.
