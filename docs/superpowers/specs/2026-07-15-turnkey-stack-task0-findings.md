# Turnkey stack — Task 0 findings (2026-07-15)

**Environment for these spikes:** Windows dev box, Docker 28.5.1, dev stack up
(`stack/docker-compose.dev.yml`: Foundry `http://localhost:30000`, relay
`http://localhost:3010`). **No rootless podman host available** in this
environment (host has no `podman`; WSL only has the `docker-desktop` distro).
Spikes requiring podman or a throwaway licensed Foundry download were **deferred
to the operator's Ubuntu host** with conservative code defaults chosen so the
build ships and self-corrects there. Each deferral is called out explicitly.

---

## §1 Headless self-pair (spike a) — VERDICT: NO-GO (default), host-verify to promote

**Live evidence gathered (Docker):**
- The `foundry-rest-api` module (3.4.1) **does** connect to the self-hosted
  relay: with a GM browser session joined to the VtM world and the module's
  `wsRelayUrl` = `ws://localhost:3010/relay`, chat logged
  `REST API connected to localhost:3010` and `GET /clients` flipped the world to
  `isOnline: true` (clientId `fvtt_a42b3a5322a6031e`). So the module→relay bridge
  and the gateway read path work end-to-end **while a GM client is connected**.
- The **fully-headless** path (relay-managed Chrome via `POST /session-handshake`
  + `POST /start-session`, no human browser) could **not be verified here**: the
  only API key available in this environment lacks the required scope (see §4 —
  `session-handshake` returns `403 API key lacks required scope: session:manage`),
  and this session had no relay-dashboard access to mint a correctly-scoped key.

**Decision:** default `HEADLESS_SELF_PAIR = false` (Task 7 `session.ts`). The
sidecar guides a **one-time browser pairing** and then relies on `attemptSession`
to keep the once-paired world online. This is the safe default and matches the
user's accepted fallback.

**ACTION (operator host, to promote to GO):** the sidecar now mints its key WITH
`session:manage` (see §4/§6). On the host, with a correctly-scoped key, run the
spike-(a) steps from the plan (virgin world, `session-handshake` +
`start-session`, confirm `isOnline` with all browsers closed ≥60 s + one `GET`).
If it passes, flip `HEADLESS_SELF_PAIR = true`.

---

## §2 felddy config.json + admin relaunch (spike b) — VERDICTS: config.json GO (by design); relaunch DEFERRED

- **config.json (b1/b2):** felddy `13.351.0` entrypoint is `./entrypoint.sh`
  (`resources/app/main.mjs --port=30000 --headless --noupdate --dataPath=/data`).
  felddy natively reads a secrets file at **`/run/secrets/config.json`** with keys
  `foundry_username`, `foundry_password`, `foundry_license_key`, `foundry_admin_key`
  (and optional `foundry_world`) — the documented, supported mechanism, keeping
  secrets out of process env. **Decision:** quickstart mounts `config.json` as the
  primary path. A throwaway licensed download was **not run here** (avoids
  consuming the user's license/bandwidth for a test); the mechanism is
  well-established, and Task 8/9 also ship the **`env_file: {format: raw}`
  fallback** so a config.json miss is non-fatal. EULA still needs a one-time UI
  acceptance on first run — the docs (Task 10) must say so.
- **admin-API world relaunch (b2):** **DEFERRED** — not verified here.
  **Decision:** Task 7 ships `relaunchWorldIfIdle` returning `'skipped'` by
  default; the status page instructs the operator to launch the world, and docs
  describe setting `foundry_world` in `config.json` (or `FOUNDRY_WORLD` env) after
  first world creation so felddy auto-launches on subsequent boots. **ACTION
  (host):** optionally verify the admin `/setup launchWorld` HTTP recipe and flip
  the default if it works.

---

## §3 Rootless podman parity (spike c) — VERDICT: DEFERRED (no podman host here)

Not runnable in this environment. The implementation is **podman-safe by
construction** (Global Constraints): no container-runtime socket anywhere
(`grep -rn "docker.sock\|podman.sock" stack/` must be zero — enforced in Task 8);
every generated secret is base64url (`A-Za-z0-9_-`), so even a compose provider
that ignores `format: raw` cannot mangle it; the web default port is **8080**
(rootless podman cannot bind <1024); the bootstrap entrypoint runs as root, chowns
the shared volume, then drops to UID 3000 (`su-exec`) — safe under rootless podman
(container root = unprivileged host user).

**ACTION (operator host, Ubuntu + rootless podman ≥4.x):** run plan spike-(c)
steps c2–c6 (`format: raw` echo probe, shared-volume 0600 read across containers,
cross-container inotify, <1024 bind error, socket audit) and record results. If
c3 fails (podman can't read the 0600 uid-3000 file as container-root), apply the
documented fallback: bootstrap stays container-root (no `su-exec` drop) — harmless
under rootless podman.

---

## §4 Captured relay endpoint payloads

- **`POST /auth/register`** — `{"email","password"}`; on conflict returns an
  "already exists" error (sidecar treats as → login). (Per `docs/HOSTING.md:139-150`.)
- **`POST /auth/login`** — `{"email","password"}` → response carries a session
  token (bearer) used for `/auth/api-keys`.
- **`POST /auth/api-keys`** — bearer `sessionToken`, body
  `{"name","scopes":[…]}` → returns the key **once** (never retrievable again →
  sidecar persists it and probe-validates, re-mints on 401/403).
- **`POST /session-handshake`** — **VERIFIED here:** requires scope
  `session:manage`. Without it: `403 {"error":"API key lacks required scope:
  session:manage"}`. Headers observed to be accepted: `x-api-key`,
  `x-foundry-url` (must resolve FROM the relay container — dev compose pins
  `hostname: foundry`, so `http://foundry:30000` works), `x-username`. Full
  request/response with a correctly-scoped key: **capture on host** (spike a).
- **`POST /start-session`** — body contract **not captured** (blocked by the
  scope 403 upstream). Capture on host during spike (a).
- **`GET /clients`** (x-api-key, `clients:read`) — **VERIFIED**, NOT throttled;
  returns `{clients:[{clientId,worldId,worldTitle,systemId,systemVersion,isOnline,…}]}`.
  This is the sidecar's key-probe call and the gateway's `RELAY_CLIENT_ID=auto`
  source. Note: `systemId` IS present here (`wod5e`/`dnd5e`) even though it is
  **absent from the per-actor `getEntity` doc** — see §6 finding 2.

---

## §5 wsRelayUrl guidance

- The module builds its socket URL as `<wsRelayUrl>`.replace(/\/relay\/?$/,"") +
  `/relay` and derives the HTTP base for `/auth/*` from it; it requires a valid
  `ws://`/`wss://` scheme (a schemeless value is rejected). Default is the SaaS
  relay `wss://foundryrestapi.com` — must be overridden.
- The module runs in **whichever browser has the world open**. For an operator on
  the LAN/another device, set `wsRelayUrl` = **`ws://<host-LAN-IP>:<relay-port>`**
  (default relay port 3010; e.g. `ws://192.168.121.63:3010`). `ws://localhost:3010`
  only works for a browser on the host itself. `ws://localhost:3010/relay` also
  works (the module normalizes the trailing `/relay`).
- The relay's own headless Chrome (spike a, host-verify) reaches Foundry via
  `x-foundry-url` using the **relay-container-internal** hostname
  (`http://foundry:30000`), independent of `wsRelayUrl`.
- We do **not** write the world settings DB — the status page + docs carry this
  instruction.

---

## §6 Decision-branch outcomes (bindings for Tasks 6–11)

1. **CORRECTION to the plan's canonical scope list (Task 6 `apps/bootstrap/src/scopes.ts`):**
   it MUST include **`session:manage`** (verified required by `session-handshake`,
   §4) — the plan's list omits it. Also include **both system scopes** the
   supported adapters need — **`dnd5e` AND `wod5e`** — since the turnkey stack is
   system-agnostic (bring-your-own-world) and the minted key must cover whichever
   system the operator's world uses. Final list:
   `["entity:read","entity:write","search","events:subscribe","clients:read","roll:execute","roll:read","chat:read","encounter:read","session:manage","dnd5e","wod5e"]`.
   If the relay rejects an unknown system scope at mint time, fall back to minting
   without the system scopes (read paths worked without a matching system scope in
   live testing) and record it.
2. **`RELAY_CLIENT_ID=auto` should also infer `systemId`** (Task 3/Task 5):
   `getEntity` actor docs do **not** carry a `systemId`, so the gateway currently
   falls back to `defaultSystemId` (dnd5e) and renders a wod5e actor with the wrong
   adapter (observed live: Marius rendered as dnd5e until `DEFAULT_SYSTEM_ID=wod5e`
   was set). But `GET /clients` **does** report `systemId` for the resolved world.
   The `ClientIdResolver` should expose the resolved world's `systemId` so the
   gateway can use it as the effective default — so operators never hit the
   dnd5e-fallback. (If Task 3's scope makes this awkward, at minimum document that
   turnkey operators set `DEFAULT_SYSTEM_ID`; but inferring it is strongly
   preferred and is a small addition to the resolver's returned `WorldHealth`.)
3. `HEADLESS_SELF_PAIR = false` default (§1); promote on host verification.
4. `relaunchWorldIfIdle` → `'skipped'` default (§2); promote on host verification.
5. Foundry secrets via `config.json` primary, `env_file: {format: raw}` fallback (§2).
6. Podman parity deferred to host (§3); code is podman-safe by construction.
