# LLM Setup Runbook — full infrastructure + Foundry connection

This document is a hand-off plan for an LLM agent (or a careful human) to
stand up the complete Foundry's Unseen Servant stack and connect it to a
Foundry VTT instance. It is self-contained: every command, every expected
output, and every piece of information the Foundry side needs is in here.
`docs/HOSTING.md` is the longer human-oriented reference; where the two
disagree, HOSTING.md wins.

**How to execute this plan (instructions to the operator LLM):**

- Work through the phases in order. Each phase ends with a **Verify** block —
  do not continue until it passes.
- Steps marked **⛔ HUMAN** cannot be done by you: they need credentials,
  a purchase, or a click inside a logged-in browser. Stop, tell the human
  exactly what to do (quote the step), and wait.
- Never print secrets (license key, passwords, API keys, invite tokens) into
  logs or chat beyond what the human must copy once.
- If a command fails, read the Troubleshooting section at the bottom before
  improvising.

---

## Inputs to collect from the human before starting

| # | Input | Needed for | Notes |
|---|-------|-----------|-------|
| 1 | Deployment shape: **LOCAL** / **EXISTING-FOUNDRY** / **VPS** | everything | see next section |
| 2 | foundryvtt.com username + password + **v13 license key** | LOCAL/VPS only | the container downloads Foundry with them |
| 3 | Existing Foundry URL + admin access + a GM account | EXISTING-FOUNDRY only | instance must be **Foundry v13** with **dnd5e 5.3.3** (hard requirement, see version pins) |
| 4 | A strong admin key string | LOCAL/VPS | protects Foundry's `/setup` |
| 5 | Player list: name + which actor(s) each plays | Phase 5 | actor ids are collected in Phase 3 |
| 6 | Who is GM in the app (sees the world roll feed) | Phase 5 | one `gm: true` entry |
| 7 | VPS + domain with DNS control | VPS only | `vtt.<domain>`, `app.<domain>` A-records |

## Version pins (do not deviate)

From `VERSIONS.md`: Foundry `felddy/foundryvtt:13.351.0`, system
**dnd5e 5.3.3**, module **foundry-rest-api 3.4.1**, relay image
`threehats/foundryvtt-rest-api-relay:3.4.1`. The dnd5e adapter reads
data paths pinned to dnd5e 5.3.3 on Foundry v13 — a different system version
is NOT supported without code review. An EXISTING-FOUNDRY instance on another
dnd5e version must be migrated to 5.3.3 first (or the plan aborted).

## Architecture (what you are building)

```
[ Web PWA ] --HTTP(S)--> [ Gateway :8090 ] --REST/SSE--> [ Relay :3010 ] <==WebSocket== [ Foundry :30000 + REST module ]
  phone browser            apps/gateway                    docker image                  module runs INSIDE a GM browser session
```

The single most important operational fact: **the REST module executes inside
a logged-in GM browser session.** If no GM is connected to the world, the
relay reports it offline and every read/write 404s. Locally that is a browser
tab someone leaves open; on a VPS the relay's headless GM session does it.

---

## Phase 0 — Workstation prerequisites + repo baseline

Requirements: Docker (Engine or Desktop, Compose v2), Node 22, pnpm 11
(`corepack enable && corepack prepare pnpm@11 --activate`), the repo checked
out.

```bash
pnpm install
pnpm -r test
```

**Verify:** all workspaces green (as of 2026-07-10: 273 adapter-dnd5e + 86
gateway + 3 foundry-client tests; `apps/web` and `adapter-sdk` are echo-only).
A red baseline means a broken checkout — stop and report.

---

## Phase 1 — Foundry itself (shape-dependent)

### Shape LOCAL — dockerized Foundry on this machine

```bash
cd stack
cp .env.example .env
# ⛔ HUMAN: fill stack/.env — FOUNDRY_USERNAME, FOUNDRY_PASSWORD,
#          FOUNDRY_LICENSE_KEY, FOUNDRY_ADMIN_KEY (input #2/#4).
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f foundry
# wait for: "Server started and listening on port 30000", then Ctrl-C the logs
```

Install the pinned system + module straight into the data volume:

```bash
# from repo root, stack running
mkdir -p stack/foundry-data/Data/systems stack/foundry-data/Data/modules
curl -L -o /tmp/dnd5e.zip https://github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/dnd5e-release-5.3.3.zip
unzip -o /tmp/dnd5e.zip -d stack/foundry-data/Data/systems/dnd5e
curl -L -o /tmp/restapi.zip https://github.com/ThreeHats/foundryvtt-rest-api/releases/download/3.4.1/module.zip
unzip -o /tmp/restapi.zip -d stack/foundry-data/Data/modules/foundry-rest-api
docker compose -f stack/docker-compose.dev.yml restart foundry
```

⛔ HUMAN first-run at <http://localhost:30000>: accept EULA → enter the admin
key → **Create World** (system: Dungeons & Dragons Fifth Edition) → Launch →
join as **Gamemaster**.

**Verify:** `curl -s http://localhost:30000/api/status` returns
`{"active":true, ..., "system":"dnd5e","systemVersion":"5.3.3"}`.

### Shape EXISTING-FOUNDRY — connect to an already-running instance

Nothing from `stack/docker-compose.dev.yml`'s `foundry` service is used; you
only run the **relay** (Phase 2) and point the existing instance's module at
it. Confirm compatibility FIRST:

```bash
curl -s <FOUNDRY_URL>/api/status
# must show "version": "13.x" and "systemVersion": "5.3.3" once the world is live
```

⛔ HUMAN: install the **Foundry REST API** module (v3.4.1) into the instance —
either via Foundry's Setup → Add-on Modules → Install Module (search
"Foundry REST API"; pick 3.4.1 explicitly), or by unzipping the release zip
(URL above) into the instance's `Data/modules/foundry-rest-api`. Then enable
it in the world (Game Settings → Manage Modules).

Network requirement: the relay must be reachable **from the GM's browser**
(the module dials out from there). If Foundry and the GM are not on this
machine's network, the relay needs a public `wss://` endpoint (TLS proxy in
front of :3010 — see HOSTING.md Part B4b for the Caddy block).

### Shape VPS — everything on one server with HTTPS

Follow `docs/HOSTING.md` Part B verbatim (Caddy + `docker-compose.prod.yml`,
headless GM session). This runbook's Phases 3–7 still apply; substitute
`https://vtt.<domain>` for `http://localhost:30000` and the internal relay
for `http://localhost:3010`.

**Production installs, in general** (VPS or a LAN box you want unattended):
use `stack/docker-compose.prod.yml` instead of `docker-compose.dev.yml` for
Phase 1/2 — it runs relay + gateway + web always-on (built from
`apps/gateway/Dockerfile` / `apps/web/Dockerfile`) with Foundry behind
`--profile foundry`:

```bash
cd stack
cp .env.gateway.example .env.gateway   # RELAY_API_KEY, RELAY_CLIENT_ID, ADMIN_PASSWORD — Phase 4/5
docker compose -f docker-compose.prod.yml --profile foundry up -d --build
```

Phases 3–7 below are unchanged; only the compose invocation and where the
gateway's secrets live differ — see `docs/HOSTING.md` Part A/B for the full
walkthrough.

---

## Phase 2 — Relay

LOCAL already started it with the compose file. EXISTING-FOUNDRY, run just the
relay service:

```bash
cd stack
docker compose -f docker-compose.dev.yml up -d relay
```

**Verify:** `curl -s http://localhost:3010/` responds (any HTTP answer means
the relay is up; auth-guarded endpoints 401 without a key — that is fine).

---

## Phase 3 — Foundry-side configuration (the complete checklist)

Everything the Foundry instance / GM must have or do. All ⛔ HUMAN unless the
agent is driving the GM's browser with permission.

1. **Module installed and enabled:** Foundry REST API **3.4.1** (Phase 1),
   enabled in the world via Game Settings → Manage Modules.
2. **Module setting — WebSocket Relay URL:** Module Settings → Foundry REST
   API → WebSocket Relay URL = `ws://localhost:3010` (LOCAL) or
   `ws://<relay-host>:3010` / `wss://relay.<domain>` (remote). Leave
   "Allow Execute JavaScript" / macro permissions **off** (default) — the
   gateway never needs them.
3. **A GM session that stays open:** the module only works while a GM browser
   is connected to the world. Locally: leave the GM tab open. VPS: the relay's
   headless session (HOSTING.md B4a).
4. **Users + actors + ownership:** create a Foundry user per player, a
   character Actor per player, and set each Actor's Ownership so its player
   is Owner. The companion app enforces its OWN access via `players.yaml`;
   Foundry ownership governs what Foundry itself lets the module do.
5. **Collect actor ids** (needed in Phase 5) — GM browser console (F12):

   ```js
   game.actors.contents.map(a => ({ id: a.id, name: a.name }))
   ```

6. **Pairing (links this world to the relay account — after Phase 4 creates
   the account):**
   - Rate-limit warning: the relay throttles `/auth/*` to ~20 req/15 min per
     IP and the module polls while the dialog is open. If pairing stalls with
     HTTP 429: `docker compose -f stack/docker-compose.dev.yml restart relay`,
     then pair within ~15 seconds.
   - GM opens the **REST API Connection** dialog (module button, or console:
     `game.modules.get('foundry-rest-api').api.openConnectionDialog()`) →
     **Pair**. It shows a CODE and opens a tab pointing at the public
     foundryrestapi.com — **ignore that tab.**
   - Open `http://localhost:3010/pair/<CODE>` (or your relay host) instead,
     sign in with the Phase-4 account, **Approve Pairing**.
   - The status in Foundry flips to paired; the token persists in that
     browser, reconnecting automatically on reload.

**Verify (after Phase 4's key exists):**

```bash
curl -s http://localhost:3010/clients -H "x-api-key: <RELAY_API_KEY>"
# -> {"clients":[{"clientId":"fvtt_...","isOnline":true, ...}]}
```

`isOnline: true` is the proof the whole Foundry side is wired. Record the
`clientId` → this is **RELAY_CLIENT_ID**.

### wod5e / second-system notes (M23)

If the world being paired runs **wod5e** (Vampire: the Masquerade 5e) rather
than dnd5e: (a) install is the same shape as any system — extract the
release zip into `Data/systems/wod5e`, no UI needed; pin **5.3.15** for
Foundry v13 (5.3.16+ requires Foundry v14, so do not take a newer release on
a v13 stack).

(b) **CRITICAL — pairing a second world:** the relay module's connection
token is `scope:'client'` — stored in the GM **browser's** localStorage, not
per-world. Pairing a second world from the **same browser profile** re-binds
that shared token and silently orphans the first world's relay client. The
symptom is unambiguous once you know it: the gateway's relay calls start
failing `401 "Invalid API key for this client ID"`, and Foundry itself
raises a notification `"code 4002: Unpaired by owner"` on the world that
lost its pairing. Avoid it by pairing each world from an **isolated browser
context** (a fresh profile/incognito window per world), or — if only one
browser profile is available — keep every world of that profile paired to
**one** relay account so there is nothing to orphan. Re-pairing the affected
world is recoverable and preserves its `clientId` (`RELAY_CLIENT_ID` does
not change), but it does mean minting/relinking a key against the account
that now holds the pairing.

(c) Scoped relay keys do not require the admin panel: any authenticated
user can mint one directly — `POST /auth/login {email,password}` returns a
session Bearer, then `POST /auth/api-keys {name, scopes}` with that Bearer
mints a scoped key (same shape as the `curl` pair in Phase 4 above, just
callable per-account without an admin UI).

---

## Phase 4 — Relay account + scoped API key

The self-hosted relay has no default credentials; create them:

```bash
# 1. register (returns a sessionToken) — pick a strong password, store it
curl -s -X POST http://localhost:3010/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"gateway@companion.local","password":"<STRONG-PASSWORD>"}'

# 2. create a SCOPED key with the sessionToken from step 1
curl -s -X POST http://localhost:3010/auth/api-keys \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <sessionToken>' \
  -d '{"name":"gateway","scopes":["entity:read","entity:write","search","events:subscribe","clients:read","dnd5e","roll:execute","chat:read","roll:read"]}'
```

The response's `key` is shown **once** → this is **RELAY_API_KEY**. Those
scopes are exactly what the gateway uses (reads, scoped writes, live push,
dnd5e actions, dice, GM roll feed) — do not widen them.

Now do Phase 3 step 6 (pairing), then Phase 3's Verify.

Pitfall from live operation: the world pairs to the **account that approved
the pairing**. If `GET /clients` with your key shows no client, the world is
paired to a different account — re-pair while signed in as
`gateway@companion.local`, or mint the key on whichever account the pairing
actually used.

---

## Phase 5 — Gateway

The gateway requires an empty `players.yaml` file at startup (the FilePlayerStore
reads it synchronously); create it before the first start:

```bash
# idempotent: never overwrite a live install's player hashes
test -f apps/gateway/players.yaml || echo "players: []" > apps/gateway/players.yaml
```

(This manual guard is only for a host-run gateway, as below. Under
`docker-compose.prod.yml` the gateway image's own entrypoint
(`apps/gateway/docker-entrypoint.sh`) does the same idempotent bootstrap
automatically against the writable `stack/gateway-data/` volume — nothing to
run by hand there.)

Then configure and start the gateway:

```bash
cd apps/gateway
```

Create `apps/gateway/.env` (gitignored — never commit):

```
PORT=8090
RELAY_URL=http://localhost:3010
RELAY_API_KEY=<from Phase 4>
RELAY_CLIENT_ID=<fvtt_... from Phase 3 Verify>
PLAYERS_FILE=./players.yaml
ADMIN_PASSWORD=<a strong password — enables the admin console below>
```

Start it:

```bash
pnpm --filter @companion/gateway start     # or `dev` for tsx watch
```

**Operational fact:** in practice the gateway does NOT reliably hot-reload —
after changing `.env` or gateway/adapter source, kill and restart the process.
(`players.yaml` itself is the exception — see Lifetimes below.)

**Verify:** `curl -s http://localhost:8090/healthz` →
`{"ok":true,"relay":"connected"}`. `"disconnected"` means Phase 3/4 is wrong
(key, clientId, or the GM session dropped).

Create players (input #5) through the admin console rather than by hand: with
`ADMIN_PASSWORD` set and the gateway restarted once, open `<app>/admin` (the
web PWA's own URL — e.g. `http://localhost:3001/admin`), log in with
`ADMIN_PASSWORD`, and use **New player** for each player from input #5,
searching for their actor by name (collected in Phase 3 step 5) and picking
it from the results. Each create/rotate shows the one-time join link and QR
code exactly once — hand it to that player immediately; it is never shown
again.

The console has no GM toggle yet: create the GM's (input #6) entry the same
way as any other player, then hand-edit their line in
`apps/gateway/players.yaml` to add `gm: true` (list every actor they may
play in `actorIds`, same as before). The hot-reload picks this up within ~1s
— no restart, and this edit is not lost on the next console-driven rewrite
(the `gm` field is carried on the in-memory player record, unlike comments —
see Lifetimes below).

Scripting alternative: `node scripts/make-invite.mjs <name> <actorId>` still
exists for bulk/unattended provisioning — it prints a join link and a YAML
block. If you hand-edit `apps/gateway/players.yaml`, the hot-reload picks up
the change live within ~1s — no restart needed, which the console above
streamlines; prefer the console unless you're scripting many players at once
outside an interactive session.

---

## Phase 6 — Web PWA

```bash
# dev server (proxies /api to the gateway on :8090):
pnpm --filter @companion/web dev            # add --host for phones on the LAN
# or a static production build (serve apps/web/.output/public behind the same host as /api):
pnpm --filter @companion/web generate
```

**Verify:** open the printed URL (e.g. <http://localhost:3001>), then a join
link `http://localhost:3001/join#<token>` — the character list loads and shows
that player's actor(s). On a phone: same Wi-Fi,
`http://<PC-LAN-IP>:3001/join#<token>`.

---

## Phase 7 — End-to-end acceptance checklist

Run through as a player, on the actor's sheet:

1. Sheet loads with LIVE badge; HP/AC/abilities match Foundry.
2. Tap a skill → a roll result appears AND the roll lands in Foundry chat.
3. Actions tab → weapon **Attack** rolls; **Dmg** rolls damage.
4. Cast a cantrip → chat card in Foundry; a leveled heal (e.g. Cure Wounds)
   rolls, displays `+N HP`, and **consumes a spell slot** in Foundry.
5. Use a limited feature (e.g. Second Wind): heals AND decrements its use;
   a second tap while spent returns a clear "no uses remaining" error.
6. Tap any row's name on the Actions tab → its description opens.
7. Change HP in Foundry → the app updates within seconds (SSE live push).
8. `GET /healthz` still `{"ok":true,"relay":"connected"}`.

All eight green = the installation is complete.

---

## Troubleshooting (verified in live operation)

- **Everything 404s / app says "reconnecting":** no GM session → world
  offline. Reopen the GM tab / restart the headless session, confirm with
  `GET /clients` → `isOnline: true`.
- **Pairing 429:** relay auth rate limit; restart the relay container, pair
  within ~15 s.
- **Pair page is foundryrestapi.com:** always swap the host for YOUR relay.
- **`/clients` empty with your key:** world paired under another account
  (see Phase 4 pitfall).
- **Gateway ignores config changes:** it does not hot-reload — restart it.
- **Compose warns about `$` in passwords:** the Foundry service must keep
  `env_file: {path: .env, format: raw}` (already set in the repo).
- **Foundry re-prompts the license/EULA after a routine restart:** its
  license signature binds to the container **hostname**. Both
  `docker-compose.dev.yml` and `docker-compose.prod.yml` pin
  `hostname: foundry` for exactly this reason — never edit or remove it once
  the license has been accepted, or the next recreate invalidates it.
- **Area-effect item use (e.g. Bead of Force) takes ~10 s:** expected — the
  relay times out while Foundry waits on its template prompt; consumption
  already happened and the app continues with the roll.
- **No upcasting:** the bridge casts at base level only; the app disables
  Cast when no base-level slot remains. Documented limitation, not a bug.
- **dnd5e/module upgrades:** pins live in `VERSIONS.md`; bump ONE at a time,
  `pnpm -r test`, then one live read/write round-trip (`docs/OPERATIONS.md`).

## Lifetimes — what stays connected, what expires

Players never log into Foundry; there is no Foundry-login redirect anywhere
in the player flow. Three independent links, three lifetimes:

- **Module ↔ relay pairing: effectively permanent.** Paired once per world
  (Phase 3 step 6); the token lives in the GM's browser and reconnects
  automatically on every world reload. In live operation it has never
  expired on its own — re-pairing was only ever needed after account
  mix-ups (Phase 4 pitfall).
- **Player ↔ app: one-time join link, valid until revoked.** Opening
  `/join#<token>` once stores the token in that player's browser; afterward
  they just open the app URL. No expiry timer exists — the token works
  until its entry is removed or replaced in `players.yaml` (rotate via the
  admin console's **New link**, or `make-invite.mjs` for scripted setups).
- **`players.yaml`: gateway-managed, hot-reloaded — no restart for edits.**
  The gateway owns this file once the admin console is in use: it carries a
  `# Managed by the gateway` header, and every create/rotate/revoke writes it
  atomically. Hand edits still work — the gateway watches the file and picks
  up external changes within ~1s, no restart needed (this is the one
  exception to "the gateway does not hot-reload," Phase 5 above). The
  trade-off: comments you add by hand do NOT survive the next
  console-driven rewrite (create/rotate/revoke), since the console
  regenerates the file from its in-memory model.
- **World online: only while a GM session is connected.** The pairing
  survives Foundry restarts, but reads/writes work only while a GM browser
  (or the VPS headless session) is attached to the world. Session flow for
  a play night: GM launches the world and joins → pairing reconnects itself
  → players open the app (already authenticated) and play.
- **World launch itself can be automated.** Once a world exists, set
  `FOUNDRY_WORLD=<world-id>` in `stack/.env` (both compose files read it) and
  the container auto-launches that world on every start/restart — no manual
  "Launch World" click. This only removes the launch click; a GM session
  still has to attach for the world to go online (previous bullet).

## Values collected along the way (final inventory)

| Name | Created in | Lives in |
|------|-----------|----------|
| `FOUNDRY_ADMIN_KEY` | Phase 1 | `stack/.env` |
| Relay account email/password | Phase 4 | password manager |
| `RELAY_API_KEY` | Phase 4 | `apps/gateway/.env` or `stack/.env.gateway` (prod compose) |
| `RELAY_CLIENT_ID` (`fvtt_…`) | Phase 3 Verify | `apps/gateway/.env` or `stack/.env.gateway` (prod compose) |
| Actor ids | Phase 3 step 5 | `apps/gateway/players.yaml` |
| Invite tokens (one per player) | Phase 5 | sent to players once; only hashes stored |
