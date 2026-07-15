# Turnkey self-hosting stack — design (2026-07-15)

## Problem

Standing up the full stack today is the worst part of the product. The
`docs/OPERATIONS.md` "First deploy" and `docs/HOSTING.md` flows require a human
to: register a relay account, mint an API key with the right scopes,
interactively **pair** a world in a logged-in GM browser (browser-approve or a
6-char code), read back the `clientId`, and keep a GM session alive. The pairing
step in particular is fragile (browser-scoped connection tokens, auth rate
limits, orphaned pairings) and is the single biggest source of setup failure.

We want a **turnkey stack**: on an Ubuntu server running **docker or rootless
podman**, an operator provides a minimum of secrets, runs one setup command, and
gets all four services running and **self-wiring** — no manual relay pairing in
the happy path. The operator brings their own world (no demo content). Runtime
services (the player PWA and Foundry) can be exposed to remote players over the
operator's own domain via an opt-in TLS profile.

## Non-negotiable constraints

1. **docker AND rootless podman parity.** No hard dependency on the
   container-runtime socket anywhere.
2. **Symbol-safe secrets.** No compose interpolation of secret values (`$` in
   passwords must survive). The repo already uses `env_file: format: raw` for
   this (`stack/docker-compose.dev.yml:7-10`).
3. **Converge, never restart.** `compose up` runs once; every service boots and
   idles/degrades until its config exists, then the stack converges on its own.
   A container must never need to recreate/restart other containers (that would
   require the socket — see constraint 1).

## Decisions (locked with the user)

- **End state:** infra up, bring-your-own-world. No demo world/character ships.
- **Auto-pairing:** a continuous **sidecar** provisions relay credentials and
  keeps the world online; no manual pairing in the happy path.
- **Access:** HTTP by default (server `IP:port`, LAN); **opt-in TLS profile**
  (Caddy) on the operator's own domain for remote GM/players.
- **Bootstrap architecture:** sidecar + shared runtime file. The sidecar mints
  the relay API key at runtime and hands it to the gateway via a file on a
  shared volume; the gateway hot-reloads it and resolves the `clientId`
  automatically from the relay's single online world.
- **Setup helper phasing:** **Phase 0** = socket-free compose + self-wiring
  sidecar. **Phase 1** = host-side `make setup` CLI + a read-only first-run
  **status page**. **Phase 2** = a LAN-bound web credential wizard — *out of
  scope for this spec*, to be specced separately, and only if operators stall at
  the CLI.
- **Pairing fallback:** if a Task 0 spike shows the relay cannot bring a
  *never-browser-paired* ("virgin") world online headlessly, a **one-time
  guided browser pairing** at setup is acceptable; the status page guides it.

**This spec covers Phases 0 + 1 only.**

## Why "verify → restart the stack" was rejected

The user's original idea was: first-run UI → verify creds → restart the whole
stack. This cannot be built under the constraints above. `env_file` is read by
the compose CLI on the host at container-create time; a container that edits a
bind-mounted `.env` cannot make other containers pick it up, and cannot restart
them without the runtime socket (constraint 1). Also, two of the things worth
"verifying" cannot be verified at setup time: the Foundry **license** (no
foundry.com API) and the **GM login** (that user does not exist until the
operator creates their world, which happens after Foundry boots). The design
therefore replaces "verify then restart" with **commit → converge → observe →
re-edit on failure**, surfaced through the status page.

## Architecture

```
        host: `make setup`  ── writes secrets files + minimal .env ──▶ `compose up`
                                                                             │
   ┌───────────────┐   REST/SSE   ┌───────────────┐   WS   ┌──────────────────────────┐
   │  gateway (BFF)│◀────────────▶│ relay (sqlite)│◀══════▶│ foundry v13 + rest module │
   └──────┬────────┘              └──────▲────────┘        └──────────────────────────┘
          │ reads RELAY_API_KEY_FILE            ▲ registers acct, mints key,
          │ + status.json (hot-reload)          │ keeps world online, writes
          ▼                                      │ relay.env + status.json
   companion-runtime (shared volume) ◀───────────┘  bootstrap sidecar
          ▲
   web PWA (static)      caddy (--profile tls, operator domain)
```

### Components

| service | image / source | role |
|---|---|---|
| `foundry` | `felddy/foundryvtt:13.351.0`, `hostname: foundry` | the VTT; reads secrets from felddy's `config.json` credentials file (keeps license/password out of process env) |
| `relay` | `threehats/foundryvtt-rest-api-relay:3.4.1`, sqlite | the bridge; account/keys/pairings in local sqlite |
| `bootstrap` | **new**, small (alpine + a Node/JS entrypoint) | provisions relay creds, keeps world online, serves the read-only status page |
| `gateway` | existing `apps/gateway/Dockerfile` + changes below | BFF; file-based key + auto clientId |
| `web` | existing `apps/web/Dockerfile` | player PWA |
| `caddy` | reuse prod Caddyfile pattern, `--profile tls` | HTTPS on operator domain |

Shared named volume `companion-runtime` mounted at `/run/companion` (bootstrap
`rw`, gateway `ro`). Runtime secret files are mode `0600`; the bootstrap image
runs as a pinned non-root UID and the file modes are set explicitly (gateway
image currently runs as root — `apps/gateway/Dockerfile` has no `USER` — so it
can read them; note this rather than rely on it).

`hostname: foundry` is pinned (the license signature binds to hostname —
`stack/docker-compose.prod.yml:62-64`).

### Config model

`make setup` runs **host-side** (so it can legitimately write files and run
`compose up` without any socket dependency). It:

1. Prompts for the **minimum** human inputs:
   - foundry.com username + password (license key optional — felddy can fetch it
     from the account).
   - TLS profile only: `DOMAIN_APP`, `DOMAIN_VTT`, `ACME_EMAIL`.
2. **Generates** everything else and shows it once: the relay account
   email/password, the Foundry GM username + password the sidecar will drive
   (operator types these when creating their GM user), the gateway
   `ADMIN_PASSWORD`, and the Foundry `admin key`.
3. Writes:
   - felddy `config.json` (Foundry credentials) to the shared volume,
   - the relay-account creds + GM creds to files the sidecar reads,
   - a small **`.env`** holding only non-secret knobs (host ports, the TLS
     profile toggle, domains) — raw format.
4. Runs `docker compose … up -d` (or `podman compose`), auto-detecting the
   runtime.

The **relay API key is not known at setup time** — the relay DB is fresh and the
account is registered at first boot. The sidecar mints it at runtime and writes
`relay.env` to the shared volume; the gateway hot-reloads it. This runtime
handoff is core (not optional).

`make setup` is idempotent and re-runnable; secret files, once written, are not
echoed back. A `--reset` path (documented) wipes generated secrets to start over.

### Bootstrap sidecar

An always-on container with a small state machine. Responsibilities:

1. **Provision the relay account & key.**
   - `POST /auth/register` the preset account → on conflict, `POST /auth/login`.
   - `POST /auth/api-keys` with the **exact scope set** required by the gateway,
     including `encounter:read` (today's `docs/HOSTING.md:149` mint command omits
     it, which would break the M22 `/api/encounter*` routes —
     `apps/gateway/src/app.ts:112`). The scope list is single-sourced here.
   - **Key lifecycle:** relay keys are shown once (`docs/HOSTING.md:152-153`), so
     "reuse" means: persist the minted key in the volume, **probe-validate** it
     with a cheap authenticated call (`GET /clients` → 200), and **re-mint only
     on 401/403**. Self-heal the case where `relay-data` (accounts DB) and
     `companion-runtime` (key file) are wiped independently (stale key vs fresh
     DB → re-mint).
   - Write `relay.env` (`RELAY_API_KEY=…`) atomically (temp-file + `rename`,
     mode `0600`).
2. **Pre-place the REST module.** Ensure the pinned `foundry-rest-api` module
   exists in the Foundry modules dir; copy it if missing. Per-world **enable**
   stays a documented one-tick operator step (do not write into the world
   settings DB).
3. **Keep the world online.** Loop: poll `GET /clients`. When Foundry has a
   launched world, ensure the relay's headless GM session is running
   (`session-handshake` + `start-session`, using the GM creds) so the world
   stays online. Backoff while Foundry is still at the setup screen.
   - **Pairing (Task 0 go/no-go):** the assumption that a headless session can
     bring a *virgin* world online is **unproven** — the module's
     `CONNECTION_TOKEN` is browser(client)-scoped, `/auth/pair` is only ever
     called from inside a world browser, and the world's relay URL defaults to
     the SaaS relay (`stack/foundry-data/.../foundry-rest-api/scripts/module.js`
     lines 1, 12, 19, 27). `session-handshake`/`start-session` appear only in
     docs, never live-run. **Task 0 must verify** headless self-pair on relay
     3.4.1; if it fails, the sidecar/status page guides a **one-time browser
     pairing** (accepted fallback) and also sets the world's `wsRelayUrl` to the
     self-hosted relay as part of that guided step.
4. **World relaunch after reboot.** felddy only auto-launches when
   `FOUNDRY_WORLD` is set (`docs/HOSTING.md:293-295`), which we cannot preset (no
   world at first boot). **Default plan:** the sidecar drives Foundry's admin API
   (`FOUNDRY_ADMIN_KEY`) to relaunch the most-recently-active world when Foundry
   is at the setup screen but a world exists — **subject to a Task 0 spike.**
   Fallback if the spike fails: the status page instructs the operator to launch
   the world, and the docs describe adding `FOUNDRY_WORLD=<id>` to `.env` after
   first world creation.
5. **Publish status.** Write `status.json` (state-machine phase + last error
   class) to the shared volume for the gateway/health surface to merge.
6. Serve the **read-only status page** (Phase 1) on a LAN-bound port: relay up →
   key minted → module present → *waiting for world* → *GM login failed: check
   FOUNDRY_GM_PASSWORD* → *pair once (if fallback)* → **online**. Read-only; no
   secret entry (that is Phase 2). Never renders stored secrets.

Robustness: bounded retries + backoff; `restart: unless-stopped` so the sidecar
re-converges after crashes; secrets never logged (mirror the gateway's existing
redaction discipline — `apps/gateway/src/config.ts`, `redactUrlToken`).

### Gateway changes

Grounded in the current code, these are larger than a first glance suggests:

- **File-sourced API key.** `loadConfig()` today hard-requires `RELAY_API_KEY`
  (`apps/gateway/src/config.ts:30-52`). Add `RELAY_API_KEY_FILE`: read at boot
  (wait-for-file with timeout → degrade if absent) and **hot-reload** on change.
  Model on `FilePlayerStore.startWatching()` (watches the parent dir,
  atomic-rename-safe, debounced, keeps last-good — `player-store.ts:59-77`) but
  as a **separate small module**: unlike `FilePlayerStore`, it must tolerate the
  file being **absent at boot and appearing later** (`player-store.ts:41-43`
  throws on a missing file — do not reuse the class).
- **Mutable relay credentials.** `FoundryRelayClient` bakes `apiKey` into
  `headers()` and `clientId` into `url()` from an immutable `RelayConfig`
  (`packages/foundry-client/src/index.ts:117-131`). Introduce provider
  functions (`apiKey()`, `clientId()`) or a mutable config so a rotated key /
  resolved clientId takes effect without a process restart.
- **`RELAY_CLIENT_ID=auto`.** When set to `auto`/empty, resolve the single
  `isOnline` world from `GET /clients`
  (`packages/foundry-client/src/index.ts:177-182`). Policy (must be explicit,
  not just tested):
  - `0` online → degrade, report reason via health.
  - `>1` online → **refuse and report**; do not pick (a second paired/orphaned
    world can exist — see the project's own orphaned-pairing history). Operator
    sets `RELAY_CLIENT_ID` explicitly to disambiguate.
  - Cache the resolved id **by `worldId`**; **never silently switch worlds** on
    re-resolve (a silent switch would send player writes into the wrong world).
  - Explicit `RELAY_CLIENT_ID` (a real `fvtt_…`) keeps today's behavior
    (back-compat).
- **Bounded probe as the resolution trigger.** A wrong/offline clientId
  **stalls** rather than errors (`docs/RELAY.md:59`; the `fetchActor` path is
  unbounded — `apps/gateway/src/app.ts:347-364`). Use a bounded health probe to
  drive (re)resolution, not organic request failure.
- **SSE re-subscription.** Three long-lived streams open at boot with the
  boot-time clientId: encounters (`apps/gateway/src/server.ts:88`), the hooks
  stream, the rolls stream. On clientId change, **abort and re-open all three.**
- **Health.** The route is `/healthz` (not `/api/healthz` —
  `apps/gateway/src/app.ts:459`). Merge the sidecar's `status.json` so one
  endpoint answers "why isn't my world online" (wrong GM password vs. world not
  created vs. module not enabled vs. needs one-time pair). Do **not** expose the
  raw `clientId` on the unauthenticated health surface — `worldTitle` + booleans
  suffice.

### TLS profile

Reuse the prod Caddy pattern, templated with `DOMAIN_APP`/`DOMAIN_VTT`/
`ACME_EMAIL`, started only under `--profile tls`. Default (no profile) exposes
`web`/`gateway`/`foundry` on host ports for LAN/IP access. Note in the docs:
over plain HTTP on a LAN IP the PWA loses installability/offline (secure-context
requirement); this does not affect remote players, who reach the app over the
operator's TLS domain.

## Data flow (happy path)

1. `make setup` (host) → writes config files + minimal `.env` → `compose up`.
2. foundry + relay boot with config present; sidecar registers the account,
   mints the key, writes `relay.env` + `status.json`, pre-places the module.
3. gateway converges — reads the key, `RELAY_CLIENT_ID=auto`; health: *waiting
   for world*.
4. Operator opens Foundry (LAN), creates a world + a GM user (name/password the
   CLI printed), enables the REST module, launches the world.
5. Sidecar brings the world online headlessly (or guides the one-time pair);
   clientId assigned.
6. gateway auto-resolves the clientId, opens the SSE streams; health: *online*.
7. Operator runs the invite helper; remote players open
   `https://app.<domain>/join#<token>`.

## Error handling

- Idempotent register (conflict → login); probe-validated key with re-mint on
  401/403; self-heal stale-key-vs-fresh-DB.
- Backoff while relay/Foundry warm or Foundry is at the setup screen.
- `restart: unless-stopped` on long-lived services → re-converge after crashes.
- Gateway degrades gracefully; every failure class is named in `status.json` and
  surfaced at `/healthz`.
- No container-runtime socket anywhere (podman parity).

## Testing

**Unit — gateway / foundry-client**
- `RELAY_API_KEY_FILE`: absent at boot then appears; hot-reload on rotate;
  degrade cleanly while absent.
- `RELAY_CLIENT_ID=auto` resolution: `0` / `1` / `>1` online; cache by
  `worldId`; **never switch worlds** on re-resolve.
- Rotating the key while the SSE streams are open re-subscribes all three.
- Back-compat: explicit `RELAY_API_KEY` + explicit `RELAY_CLIENT_ID` behave as
  today. Mirror `apps/gateway/test/config.test.ts` / `registry.test.ts` idioms
  with a fake relay.

**Unit — bootstrap**
- register→conflict→login; key persist / probe-validate / re-mint on 401/403;
  session-ensure state machine; exact scope set (incl. `encounter:read`);
  atomic `relay.env` write; `status.json` transitions. Against a fake relay HTTP
  server.

**Task 0 — go/no-go spikes (gate the plan)**
- (a) **Headless self-pair of a virgin world** on relay 3.4.1 (self-hosted): can
  `session-handshake`/`start-session` bring a never-browser-paired world online,
  and who sets `wsRelayUrl`? If no → adopt the one-time guided browser pairing
  and spec that step concretely.
- (b) **felddy `config.json` secrets file** behavior on `13.351.0` + **admin-API
  world (re)launch** with `FOUNDRY_ADMIN_KEY`.
- (c) **rootless podman**: shared-volume perms/UID/umask, `env_file: format:
  raw`, and no-socket `compose` parity.

**Integration**
- Live table-loop on the quickstart compose (join link → sheet → HP write
  round-trips → SSE push), on **docker and podman**.
- Regression: existing `dev`/`prod` composes untouched; full `pnpm test` green.

## Out of scope (v1)

- Demo world/character content.
- **Phase 2 web credential wizard** (separate spec; LAN-bound; localhost/one-time
  token/auto-disable security model when it is built).
- Post-setup config-management / secret-rotation UI.
- Multi-world auto-management (v1 refuses `>1` online and asks for an explicit
  clientId).
- Wizard-driven ACME/TLS bootstrap.

## Open items resolved at implementation time (not blocking)

- Exact relay endpoint payloads for `register`/`login`/`api-keys`/
  `session-handshake`/`start-session` on 3.4.1 (Task 0 captures them).
- Final choice of world-relaunch mechanism (Task 0 (b) decides admin-API vs
  documented `FOUNDRY_WORLD` edit).
