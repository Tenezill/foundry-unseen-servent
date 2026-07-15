# Turnkey Self-Hosting Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an Ubuntu server with docker OR rootless podman, an operator runs `make setup`, answers a handful of prompts, runs nothing else — and gets all four services running and self-wiring (sidecar mints the relay key at runtime, gateway hot-loads it and auto-resolves the clientId, world kept online headlessly), with an opt-in TLS profile for remote players.

**Architecture:** A new always-on **bootstrap sidecar** container provisions the relay account/key over the relay HTTP API, hands the key to the gateway via an atomic `relay.env` on a shared `companion-runtime` volume, pre-places the REST module, keeps the world online (`session-handshake`/`start-session`), and publishes `status.json` + a read-only status page. The **gateway** gains a file-sourced hot-reloading API key (`RELAY_API_KEY_FILE`), `RELAY_CLIENT_ID=auto` resolution driven by a bounded probe (cache by `worldId`, never switch worlds), SSE re-subscription on identity change, and a `/healthz` that merges the sidecar's status. A host-side `make setup` CLI generates secrets and runs the new socket-free `stack/quickstart` compose.

**Tech Stack:** Existing stack (Fastify gateway, foundry-client, vitest, pnpm workspace). Sidecar = new `@companion/bootstrap` workspace package, Node 22 + TypeScript via tsx, **zero runtime deps beyond tsx** (node:http/node:fs only) — chosen over a shell/Go sidecar because it shares the repo's language, lockfile, Dockerfile pattern and vitest idiom, and its state machine is unit-testable against a fake relay HTTP server exactly like the gateway's fakes.

**Spec:** `docs/superpowers/specs/2026-07-15-turnkey-stack-design.md`
**Task 0 findings (produced by Task 0, READ before Tasks 6-11):** `docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md`

## Global Constraints

- **docker AND rootless podman parity.** No hard dependency on the container-runtime socket anywhere — no service mounts `/var/run/docker.sock` or the podman socket, ever.
- **Symbol-safe secrets.** No compose interpolation of secret values (`$` in passwords must survive): secrets travel via `env_file: {path: …, format: raw}` or mounted files. Belt-and-braces: every secret the setup CLI *generates* is base64url (`A-Za-z0-9_-` only).
- **Converge, never restart.** `compose up` runs once; every service boots and idles/degrades until its config exists, then the stack converges on its own. A container must never need to recreate/restart another container.
- **Pinned versions** (VERSIONS.md): `felddy/foundryvtt:13.351.0`, `threehats/foundryvtt-rest-api-relay:3.4.1`, `foundry-rest-api` module `3.4.1`.
- **`hostname: foundry` is pinned** on the Foundry service — the license signature binds to the hostname (`stack/docker-compose.prod.yml:62-64`).
- **Runtime secret files are mode `0600`**, written atomically (same-dir temp file + `rename`). The bootstrap image runs as a pinned non-root UID (3000); the gateway image currently runs as root (`apps/gateway/Dockerfile` has no `USER`) and reads them by that fact — noted explicitly, verified for rootless podman in Task 0(c), never silently relied on.
- **Back-compat:** explicit `RELAY_API_KEY` + explicit `RELAY_CLIENT_ID` keep today's behavior exactly; `stack/docker-compose.dev.yml` and `stack/docker-compose.prod.yml` are untouched.
- **Secrets never logged, never in client-visible bodies** — including `/healthz`: no api key, no clientId (worldTitle + booleans/reasons only). Mirror the gateway's redaction discipline (`apps/gateway/src/config.ts` `redactUrlToken`, `server.ts` redact paths).
- **Every relay await is bounded** (M18 pattern): a wrong/offline clientId **stalls** rather than errors (`docs/RELAY.md:59`), so clientId (re)resolution is driven ONLY by a bounded probe, never by organic request failure.
- **Never silently switch worlds:** auto-resolution caches by `worldId`; `>1` online worlds ⇒ refuse and report; a different single online world is never adopted mid-run.
- Strict TS, ESM `.js` import suffixes; `pnpm typecheck && pnpm test` green is a hard gate at the end of every code task.
- Commit per task, trailer:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Pitfalls & mitigations

Beyond the spec's own list — each is owned by a named task:

1. **Relay `/auth/*` throttle (~20 req/15 min per IP, `docs/HOSTING.md:159-161`).** The sidecar's key probe uses `GET /clients` (x-api-key, NOT throttled), touches `/auth/*` only when the probe fails, and enforces a ≥60 s backoff between auth attempts (Task 6/7). Task 0 spikes budget ≤5 `/auth` calls each.
2. **Named-volume first-mount ownership race.** Docker/podman "copy-up" initializes an empty named volume from the FIRST container that mounts it — if the gateway (whose image has no `/run/companion`) mounts first, the volume stays root-owned and a UID-3000 sidecar cannot write. Fix: the bootstrap entrypoint starts as root, `chown`s `$RUNTIME_DIR`, then drops to UID 3000 via `su-exec` (Task 7). Verified on both runtimes in Task 0(c).
3. **Gateway-as-root reading a `0600` UID-3000 file under rootless podman.** Container root has `CAP_DAC_OVERRIDE` only for UIDs mapped into its user namespace; default rootless podman maps the same subuid range for all containers of one user, so this works — but `--userns=auto` would break it. Task 0(c) proves it; the fallback (bootstrap runs as container root, harmless under rootless podman) is documented in the findings if it fails.
4. **`fs.watch` may miss cross-container writes on a shared volume.** inotify usually works (same host kernel/fs), but the gateway's `ApiKeySource` also polls (default 5 s) as a backstop, and `reload()` is idempotent/change-suppressed (Task 1). Task 0(c) measures whether inotify fires at all.
5. **Rootless podman cannot bind ports <1024** (default `ip_unprivileged_port_start=1024`). Quickstart default web port is **8080**, not 80; the TLS profile (80/443) documents the `sysctl` prerequisite (Tasks 8/10).
6. **`env_file: format: raw` support varies by podman compose provider.** Task 0(c) records which provider (docker-compose-as-podman-provider vs python podman-compose) honors it. Defused by design: every quickstart env-file secret is CLI-*generated* base64url, so even a provider that ignores `format: raw` cannot mangle them (Task 9).
7. **`wsRelayUrl` defaults to the SaaS relay** (`wss://foundryrestapi.com`, `module.js` line 1) and is a per-world module setting. Someone must point it at the self-hosted relay. Task 0(a) determines the ONE value that works for both the relay's headless Chrome (same container as the relay ⇒ `ws://localhost:3010` works there) and the operator's browser (host LAN IP) — captured in findings §5; the status page + docs carry the instruction (Tasks 7/10). We do NOT write the world settings DB.
8. **Pairing a 2nd world from the same browser orphans the 1st** (project memory, live-verified). Task 0(a) uses a fresh/incognito browser context for any browser step and re-verifies the existing dev world's pairing afterwards.
9. **Mid-rotation blank window.** The sidecar writes `relay.env` atomically; the gateway keeps the last-good key when the file is momentarily absent/unparseable and emits a change event only when the parsed key actually differs (Task 1).
10. **SSE streams opened under the old identity survive the rotation** until the relay drops them. On any identity change (key OR clientId) the gateway aborts + re-opens all relay-side streams: LiveManager hooks, EncounterManager hooks, and every `/rolls/subscribe` held by a gm-rolls SSE connection (Task 4).
11. **`/healthz` could stall** — today it awaits `relay.listClients()` unbounded. Task 5 bounds it (3 s race). While the key file has not appeared yet, `relay: "disconnected"` is expected; the merged `world.reason: "key-unavailable"` disambiguates.
12. **status.json is read on an unauthenticated surface.** The gateway parses it through a strict field whitelist (`phase`, `detail`, `error.class`, `error.message`, `updatedAt`) — arbitrary/unknown fields are dropped, so nothing the sidecar (or an attacker with volume access) writes can leak through `/healthz` (Task 5).
13. **Repeated `session-handshake` attempts spawn headless-Chrome logins.** The sidecar attempts a session at most every `SESSION_BACKOFF_MS` (default 60 s) while offline, and only ever polls `GET /clients` in between (Task 7).
14. **`chmod`/file-mode assertions are meaningless on the Windows dev box.** Every test asserting `0600`/`0644` modes is wrapped in `it.skipIf(process.platform === 'win32')` (Tasks 6). CI/servers (Linux) still enforce them.
15. **Port collisions with the dev/prod stacks.** Quickstart is a separate compose project (`stack/quickstart/`, own named volumes) but publishes 30000/3010 by default — the docs say not to run it beside the dev stack on one host without overriding `HOST_PORT_*` (Task 10).
16. **Gateway has no `@types/node`** (deliberate; `apps/gateway/src/node-shims.d.ts`). New gateway modules stick to the already-shimmed surface (`readFileSync`, `watch`, `FSWatcher`) — no shim edits needed. The bootstrap package is a different package and gets its own `@types/node` devDependency (contained by pnpm isolation; the gateway's typecheck never sees it) (Task 6).
17. **Relay stores GM credentials encrypted under `relay-data/.secrets.env`** (`CREDENTIALS_ENCRYPTION_KEY`, `docs/RELAY.md:70-74`). Wiping `relay-data` invalidates both the minted key AND the stored GM login — the sidecar self-heals both (probe→re-mint; session-ensure re-runs the handshake with the GM creds it holds) (Tasks 6/7, drilled in Task 11).
18. **Invite flow interaction:** unchanged. `ADMIN_PASSWORD` is preset by the CLI so the `/admin` console works immediately; `players.yaml` still lives on the gateway-data volume and is bootstrapped empty by the existing gateway entrypoint (`apps/gateway/docker-entrypoint.sh`). `scripts/make-invite.mjs` needs no changes.

---

## File Structure

**Create**

| path | responsibility |
|---|---|
| `docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md` | Task 0 verdicts, captured endpoint payloads, decision-branch outcomes |
| `apps/gateway/src/key-source.ts` | `ApiKeySource` + `parseKeyFile`: file-sourced relay key; absent-at-boot tolerant, watch+poll hot reload, last-good semantics |
| `apps/gateway/src/client-id-resolver.ts` | `ClientIdResolver` + `WorldHealth`: RELAY_CLIENT_ID=auto policy (0/1/>1, worldId cache, never-switch, bounded probe) |
| `apps/gateway/src/status-file.ts` | `readBootstrapStatus`: whitelist reader for the sidecar's status.json |
| `apps/gateway/test/key-source.test.ts` | ApiKeySource unit tests |
| `apps/gateway/test/client-id-resolver.test.ts` | resolver policy unit tests |
| `apps/gateway/test/identity-restart.test.ts` | stream re-subscription on identity change |
| `apps/gateway/test/healthz-status.test.ts` | merged /healthz + status-file whitelist tests |
| `apps/bootstrap/package.json`, `apps/bootstrap/tsconfig.json` | new `@companion/bootstrap` workspace package |
| `apps/bootstrap/src/scopes.ts` | THE canonical gateway key scope list (incl. `encounter:read`) |
| `apps/bootstrap/src/relay-auth.ts` | `RelayAuthClient`: register/login/mint/probe/clients/session endpoints (sidecar-only surface) |
| `apps/bootstrap/src/key-file.ts` | atomic 0600 `relay.env` write + persisted-key read |
| `apps/bootstrap/src/status.ts` | `StatusWriter` + `BootstrapPhase`/`BootstrapStatus`: atomic status.json |
| `apps/bootstrap/src/provision.ts` | `ensureKey`: persist → probe-validate → re-mint on 401/403 state machine |
| `apps/bootstrap/src/session.ts` | `worldOnline` + `attemptSession`: keep-the-world-online pass |
| `apps/bootstrap/src/module-install.ts` | `ensureModulePlaced`: copy pinned module into Foundry's Data/modules |
| `apps/bootstrap/src/foundry-admin.ts` | `relaunchWorldIfIdle`: admin-API world relaunch (Task 0(b)-gated) |
| `apps/bootstrap/src/status-page.ts` | read-only LAN status page (node:http), phase guidance, no secrets |
| `apps/bootstrap/src/main.ts` | the converge loop |
| `apps/bootstrap/test/fake-relay-server.ts` | in-process fake relay HTTP server for unit tests |
| `apps/bootstrap/test/{provision,key-file,status,session,module-install,status-page,setup-cli}.test.ts` | sidecar + CLI unit tests |
| `apps/bootstrap/test/mjs.d.ts` | typed named-export declarations for the host-side `.mjs` CLI |
| `apps/bootstrap/Dockerfile`, `apps/bootstrap/docker-entrypoint.sh` | sidecar image (bakes module 3.4.1; chown-then-drop entrypoint) |
| `stack/quickstart/docker-compose.yml` | the socket-free quickstart stack (own compose project) |
| `stack/quickstart/Caddyfile` | HTTP default for the web service |
| `stack/quickstart/Caddyfile.tls.example` | TLS template the CLI instantiates |
| `stack/quickstart/.env.example`, `stack/quickstart/secrets/*.example` | manual-path templates (CLI writes the real ones) |
| `scripts/setup-quickstart.mjs` | host-side setup CLI (prompt → generate → write → compose up) |
| `Makefile` | `make setup` / `make setup-reset` entry points |

**Modify**

| path | change |
|---|---|
| `packages/foundry-client/src/index.ts:8-18,117-131` | `RelayConfig.apiKey/clientId` accept `string \| (() => string)`; resolved per request |
| `apps/gateway/src/config.ts:7-59` | `RELAY_API_KEY_FILE`, `KEY_BOOT_WAIT_MS`, `RELAY_CLIENT_ID=auto` normalization, `STATUS_FILE` |
| `apps/gateway/src/server.ts:1-96` | full turnkey wiring (key source, resolver, identity fan-out, status merge) |
| `apps/gateway/src/app.ts:132-163` (GatewayDeps), `:385-387` (cleanup sets), `:614-672` (gm-rolls route), `:459-468` (healthz) | identity-change dep + roll-stream registry + merged healthz |
| `apps/gateway/src/live.ts:187-210` | `LiveManager.restartStream()` |
| `apps/gateway/src/encounters.ts:127-137` | `EncounterManager.restartStream()` |
| `apps/gateway/test/fakes.ts:62-69` | `hangListClients` flag on FakeRelay |
| `.gitignore` | quickstart generated files |
| `docs/HOSTING.md`, `docs/OPERATIONS.md`, `VERSIONS.md` | Part C quickstart, ops notes, pin locations |

---

### Task 0: Go/no-go spikes (live) → findings doc

No production code. Three live spikes against real software; every later task consumes the findings file. The dev stack is currently UP (`stack/docker-compose.dev.yml`: Foundry `http://localhost:30000`, relay `http://localhost:3010`). **Budget ≤5 `/auth/*` calls per 15 minutes** (relay throttle); if a 429 appears, `docker compose -f stack/docker-compose.dev.yml restart relay` resets the limiter, then continue within ~15 s.

Create the findings doc skeleton FIRST so every step has a place to record results:

- [ ] **Step 0.0** — create `docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md` with these section headers: `## §1 Headless self-pair (spike a) — VERDICT: GO|NO-GO`, `## §2 felddy config.json + admin relaunch (spike b) — VERDICTS`, `## §3 Rootless podman parity (spike c) — VERDICTS`, `## §4 Captured relay endpoint payloads (register/login/api-keys/session-handshake/start-session)`, `## §5 wsRelayUrl guidance`, `## §6 Decision-branch outcomes`.

#### Spike (a): headless self-pair of a *virgin* world on self-hosted relay 3.4.1

Pass criterion: a world that has **never been browser-paired** reaches `isOnline: true` in `GET /clients` — with all human browser tabs closed for ≥60 s and one successful `GET /get` read — using only `POST /session-handshake` + `POST /start-session`.

- [ ] **Step a1 — baseline.** Read `RELAY_API_KEY` from `stack/.env.gateway` (do not print it into any committed file). Record the current pairing baseline: `curl -s http://localhost:3010/clients -H "x-api-key: $KEY"` → note the existing world's `clientId`/`worldId`/`isOnline`. This baseline is re-checked in a8.
- [ ] **Step a2 — create the virgin world.** Foundry UI `http://localhost:30000` (admin key in `stack/.env` `FOUNDRY_ADMIN_KEY`): Create World, id `spike-virgin`, system dnd5e, launch it. In a **fresh incognito/private window** (pitfall 8): join as `Gamemaster`, set the Gamemaster user a password (`spike-gm-pass`), create one throwaway actor (note its id), enable the **Foundry REST API** module (Manage Modules), set the module's **WebSocket Relay URL** to `ws://localhost:3010`, and — critically — do **NOT** click Pair. Save & close the tab. Record in findings §5: the module's connection behavior while enabled-but-unpaired (console/network observations).
- [ ] **Step a3 — throwaway relay account + key** (3 `/auth` calls):
  ```bash
  curl -s -X POST http://localhost:3010/auth/register -H 'content-type: application/json' \
    -d '{"email":"spike@companion.local","password":"spike-pass-1"}'
  curl -s -X POST http://localhost:3010/auth/login -H 'content-type: application/json' \
    -d '{"email":"spike@companion.local","password":"spike-pass-1"}'
  # paste the session token from the login response:
  curl -s -X POST http://localhost:3010/auth/api-keys -H 'content-type: application/json' \
    -H "authorization: Bearer <sessionToken>" \
    -d '{"name":"spike","scopes":["entity:read","entity:write","search","events:subscribe","clients:read","dnd5e","roll:execute","chat:read","roll:read","encounter:read"]}'
  ```
  Record in findings §4 the EXACT response JSON of all three (field names for the session token and the key; the register-conflict status code by re-running register once). Also record whether the relay accepted the full scope list verbatim.
- [ ] **Step a4 — headless attempt.** With the spike key:
  ```bash
  curl -sv -X POST http://localhost:3010/session-handshake \
    -H "x-api-key: $SPIKE_KEY" -H "x-foundry-url: http://foundry:30000" -H "x-username: Gamemaster"
  ```
  (`x-foundry-url` must be reachable FROM the relay container — the dev compose pins `hostname: foundry`, so `http://foundry:30000` resolves.) Record status + full body in §4. Then drive `POST /start-session` with the handshake response + the GM password; the exact body contract is unknown — first try `-d '{"token":"<from handshake>","password":"spike-gm-pass"}'`; on 4xx, read `docker compose -f stack/docker-compose.dev.yml logs relay --tail 100` for the expected shape and iterate (these are NOT `/auth/*` calls — no throttle). Record the working (or definitively failing) request/response pair in §4.
- [ ] **Step a5 — verify online.** `curl -s http://localhost:3010/clients -H "x-api-key: $SPIKE_KEY"` — does a client for `spike-virgin` appear with `isOnline: true`? Close ALL browser tabs, wait 60 s, re-check, then `curl -s "http://localhost:3010/get?clientId=<id>&uuid=Actor.<throwaway-actor-id>" -H "x-api-key: $SPIKE_KEY"` → expect the actor doc. Record §1 verdict **GO** if all pass.
- [ ] **Step a6 — wsRelayUrl cross-check** (findings §5). While the headless session is up, note that the module (in relay-container Chrome) used `ws://localhost:3010` successfully (same container). Then answer: what single value also works for an operator's browser on another machine? Test once by loading the world from a second device/browser profile pointed at `ws://<host-LAN-IP>:3010` (change the module setting, reload, watch the connection status), and whether the headless Chrome still connects with the LAN-IP value after a `docker compose restart relay`. Record the recommended value (expected: `ws://<host-LAN-IP>:3010` for both; fall back to documenting two-phase guidance if the container cannot reach the host IP).
- [ ] **Step a7 — NO-GO branch (only if a5 failed).** If the world never comes online headlessly: perform the one-time browser pairing ONCE in the incognito window (module Connection dialog → Pair → open `http://localhost:3010/pair/<CODE>` → sign in as the spike account → Approve), confirm `isOnline: true`, then close all tabs, `docker compose -f stack/docker-compose.dev.yml restart relay`, and test whether `session-handshake`+`start-session` NOW brings the once-paired world back online headlessly (this is the fallback's steady state and MUST work for the fallback to be viable). Record §1 verdict **NO-GO + fallback-verified** with the exact guided steps.
- [ ] **Step a8 — cleanup + baseline re-check.** Delete the `spike-virgin` world (Foundry setup UI), re-run the a1 baseline `GET /clients` with the production key and confirm the original world's pairing is intact and `isOnline` unchanged. Record any relay-side leftovers (spike account/pairing rows are harmless; note them).

**Decision branch (a):** GO ⇒ Task 7's `session.ts` sets `HEADLESS_SELF_PAIR = true` (virgin worlds are self-paired). NO-GO ⇒ `HEADLESS_SELF_PAIR = false`; the `needs-pairing` status-page flow (Task 7) and docs Part C (Task 10) carry the verified one-time guided pairing; `attemptSession` still runs for the once-paired-then-offline case.

#### Spike (b): felddy `config.json` secrets + admin-API world relaunch (13.351.0)

Pass criteria: (b1) Foundry reaches "Server started and listening on port 30000" with credentials supplied ONLY via a mounted `config.json` (none in process env); (b2) a world is (re)launched from the setup screen via HTTP calls authenticated by `FOUNDRY_ADMIN_KEY` alone.

- [ ] **Step b1 — throwaway project.** In the scratchpad directory (NOT `stack/`), write `spike-felddy/docker-compose.yml`:
  ```yaml
  name: spike-felddy
  services:
    foundry:
      image: felddy/foundryvtt:13.351.0
      hostname: foundry-spike
      ports: ["30001:30000"]
      volumes:
        - foundry-spike-data:/data
        - ./config.json:/run/secrets/config.json:ro
  volumes:
    foundry-spike-data:
  ```
  and `spike-felddy/config.json` (credentials copied from `stack/.env` — never commit this file):
  ```json
  {
    "foundry_username": "<from stack/.env>",
    "foundry_password": "<from stack/.env>",
    "foundry_license_key": "<from stack/.env>",
    "foundry_admin_key": "spike-admin-key-1"
  }
  ```
  `docker compose -f spike-felddy/docker-compose.yml up -d`, then `logs -f foundry` until "Server started" (or a credential error). Record in §2: the exact log line proving the secrets file was read, and whether the EULA still required a one-time UI acceptance (expected: yes — record it; the quickstart docs must include that step).
- [ ] **Step b2 — env cleanliness.** `docker compose -f spike-felddy/docker-compose.yml exec foundry env | grep -i foundry` → record that `FOUNDRY_PASSWORD`/`FOUNDRY_LICENSE_KEY` do NOT appear in the container environment. Also record which `config.json` keys felddy honors on this tag (check the image docs/entrypoint: `docker compose -f spike-felddy/docker-compose.yml exec foundry cat /entrypoint.sh 2>/dev/null || docker inspect felddy/foundryvtt:13.351.0 --format '{{.Config.Entrypoint}}'`, and grep the entrypoint source for `secrets`): expected set `foundry_username|foundry_password|foundry_license_key|foundry_admin_key|foundry_world`.
- [ ] **Step b3 — proxy-var empty check** (needed by Task 8's interpolated knobs): recreate with `environment: [FOUNDRY_PROXY_SSL=false, FOUNDRY_PROXY_PORT=]` added and record whether an EMPTY `FOUNDRY_PROXY_PORT` boots cleanly (treated as unset) or errors. Record in §2.
- [ ] **Step b4 — admin relaunch.** Do the one-time UI setup on `http://localhost:30001` (EULA, admin key `spike-admin-key-1`, create a minimal world `spike-world` — any system already cached, else dnd5e via A3's zip drop into the volume). Return Foundry to the setup screen (world not running). Locate the launch route: `docker compose -f spike-felddy/docker-compose.yml exec foundry sh -c "grep -rl 'launchWorld' /home/foundry/resources/app --include='*.*js' | head -5"` and inspect the matching handler for the expected POST body/auth. Then capture a working curl recipe; first attempt:
  ```bash
  curl -sv -c /tmp/spike-cookies.txt -X POST http://localhost:30001/auth \
    -H 'content-type: application/json' -d '{"action":"adminAuth","adminPassword":"spike-admin-key-1"}'
  curl -sv -b /tmp/spike-cookies.txt -X POST http://localhost:30001/setup \
    -H 'content-type: application/json' -d '{"action":"launchWorld","world":"spike-world"}'
  curl -s http://localhost:30001/api/status   # expect the world active
  ```
  Iterate against the inspected handler until the world launches (or conclude it cannot be done over HTTP). Record the exact working recipe (routes, bodies, cookie requirements) — or the NO-GO evidence — in §2, plus the shape of `GET /api/status` for both idle and world-active states (Task 7's `relaunchWorldIfIdle` keys on it).
- [ ] **Step b5 — cleanup.** `docker compose -f spike-felddy/docker-compose.yml down -v` and delete the scratch `config.json`.

**Decision branches (b):** (b1 FAIL) ⇒ quickstart passes Foundry creds via `env_file: {format: raw}` instead of `config.json` (accepted degradation; Task 8/9 note flips their foundry-secrets wiring, everything else unchanged). (b2 FAIL) ⇒ Task 7 ships `relaunchWorldIfIdle` returning `'skipped'` unconditionally; the status page instructs the operator to launch the world; docs document adding `foundry_world` to `config.json` (or `FOUNDRY_WORLD` env) after first world creation.

#### Spike (c): rootless podman parity

Requires an Ubuntu host (a WSL2 Ubuntu distro on the dev box qualifies) with rootless podman ≥4.x AND docker. If no such host is available, STOP and escalate to the human — Tasks 8/11 gate on this.

- [ ] **Step c1 — provider inventory.** Record `podman --version`, `podman compose version` (which provider it delegates to), and whether `podman-compose --version` (python) exists. Record in §3.
- [ ] **Step c2 — `format: raw` probe.** Scratch project:
  ```yaml
  name: spike-raw
  services:
    echoer:
      image: alpine:3.20
      env_file:
        - path: ./secret.env
          format: raw
      command: sh -c 'echo "PW=[$$PW]"'
  ```
  with `secret.env` containing `PW=we$ird$pa55`. Run under `docker compose` and `podman compose`: PASS = output `PW=[we$ird$pa55]` verbatim on both. Record per-provider verdicts in §3 (including "provider rejects the long-form env_file syntax entirely", if so).
- [ ] **Step c3 — shared-volume ownership + 0600 read.** Scratch project mirroring the bootstrap/gateway pattern:
  ```yaml
  name: spike-vol
  services:
    writer:
      image: alpine:3.20
      user: "0"
      command: sh -c 'chown 3000:3000 /run/companion && echo "RELAY_API_KEY=k123" > /tmp/f && install -m 600 -o 3000 -g 3000 /tmp/f /run/companion/relay.env && sleep 600'
      volumes: [companion-runtime:/run/companion]
    reader:
      image: alpine:3.20
      user: "0"
      command: sh -c 'sleep 5; ls -ln /run/companion; cat /run/companion/relay.env'
      volumes: [companion-runtime:/run/companion:ro]
  volumes:
    companion-runtime:
  ```
  PASS = reader prints `RELAY_API_KEY=k123` under BOTH docker and rootless podman (proves: root-entrypoint chown works on the named volume; container-root reads a 0600 uid-3000 file; `:ro` remount works). Record §3; if podman fails the read, record the fallback decision (bootstrap stays container-root, no `su-exec` drop) for Task 7.
- [ ] **Step c4 — cross-container inotify.** Replace the images with `node:22-alpine`; writer appends to `/run/companion/relay.env` every 2 s; reader runs `node -e "const fs=require('fs');fs.watch('/run/companion',(e,f)=>console.log('event',e,f));setTimeout(()=>{},60000)"`. Record in §3 whether events fire under each runtime (either answer is fine — the gateway polls too — but the findings must say which).
- [ ] **Step c5 — privileged ports.** `podman run --rm -p 80:80 alpine:3.20 true` → expect a bind error; record it (justifies the 8080 default + TLS-profile sysctl note).
- [ ] **Step c6 — socket audit.** `grep -rn "docker.sock\|podman.sock" stack/` → expect zero hits; record.
- [ ] **Step c7 — cleanup** all spike projects (`down -v`), then commit the findings doc:
  ```bash
  git add docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md
  git commit -m "docs: turnkey stack Task 0 findings (headless pairing, felddy secrets, podman parity)"
  ```

---

### Task 1: Gateway file-sourced relay key — `ApiKeySource` + config

**Files:**
- Create: `apps/gateway/src/key-source.ts`
- Modify: `apps/gateway/src/config.ts:7-59` (interface + loadConfig)
- Test: `apps/gateway/test/key-source.test.ts` (new), `apps/gateway/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new (node:fs `readFileSync`/`watch` — already shimmed in `apps/gateway/src/node-shims.d.ts`; do NOT use `existsSync`, it is not shimmed).
- Produces (Task 4's server.ts consumes):

```ts
// key-source.ts
export function parseKeyFile(text: string): string | null;
export class ApiKeySource {
  constructor(filePath: string, opts?: { pollMs?: number });
  current(): string | null;                        // last good key; null before first read
  onChange(cb: (key: string) => void): () => void; // fires on every key CHANGE (incl. first appearance)
  waitUntilAvailable(timeoutMs: number): Promise<boolean>; // bounded boot wait
  startWatching(log?: { warn(obj: object, msg: string): void }): void; // initial read + dir watch + poll backstop
  stopWatching(): void;
}

// config.ts — GatewayConfig gains:
//   relayApiKey?: string;        (explicit, back-compat; wins over the file)
//   relayApiKeyFile?: string;    (turnkey; may be absent at boot)
//   keyBootWaitMs: number;       (KEY_BOOT_WAIT_MS, default 15000)
// loadConfig throws only when NEITHER RELAY_API_KEY nor RELAY_API_KEY_FILE is set.
```

Design notes (why not reuse `FilePlayerStore`): its constructor `readFileSync`s and throws on a missing file (`player-store.ts:41-43`); the key file is legitimately absent at boot. The watcher idiom (watch the PARENT dir — atomic renames orphan a file watch — debounce 300 ms) is copied from `player-store.ts:59-77`; a poll (default 5 s) backstops inotify on shared volumes (Pitfall 4), and a 1 s retry timer covers a parent dir that does not exist yet. `reload()` keeps the last good key on absence/unparseable (Pitfall 9) and emits only when the parsed key actually changed.

- [ ] **Step 1: Write the failing tests** — `apps/gateway/test/key-source.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeySource, parseKeyFile } from '../src/key-source.js';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('parseKeyFile', () => {
  it('takes the first RELAY_API_KEY= line', () => {
    expect(parseKeyFile('RELAY_API_KEY=abc123\n')).toBe('abc123');
    expect(parseKeyFile('# minted 2026-07-15\nRELAY_API_KEY=k-1\nRELAY_API_KEY=k-2\n')).toBe('k-1');
    expect(parseKeyFile('RELAY_API_KEY=has$ym-bo_ls\n')).toBe('has$ym-bo_ls');
  });
  it('accepts a bare-key file (no = anywhere)', () => {
    expect(parseKeyFile('  bare-key-123  \n')).toBe('bare-key-123');
  });
  it('rejects empty/other content', () => {
    expect(parseKeyFile('')).toBeNull();
    expect(parseKeyFile('OTHER=x\n')).toBeNull();
    expect(parseKeyFile('RELAY_API_KEY=\n')).toBeNull();
  });
});

describe('ApiKeySource', () => {
  const sources: ApiKeySource[] = [];
  const dirs: string[] = [];
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'keysrc-'));
    dirs.push(dir);
    return dir;
  }
  function makeSource(filePath: string): ApiKeySource {
    const src = new ApiKeySource(filePath, { pollMs: 50 });
    sources.push(src);
    return src;
  }
  afterEach(() => {
    for (const s of sources.splice(0)) s.stopWatching();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('tolerates the file being absent at boot and picks it up when it appears', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    const src = makeSource(file);
    const seen: string[] = [];
    src.onChange((k) => seen.push(k));
    src.startWatching();
    expect(src.current()).toBeNull();
    writeFileSync(file, 'RELAY_API_KEY=first-key\n', 'utf8');
    await waitFor(() => src.current() === 'first-key');
    expect(seen).toEqual(['first-key']);
  });

  it('hot-reloads on an atomic rename rotation and emits exactly once per change', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    writeFileSync(file, 'RELAY_API_KEY=first-key\n', 'utf8');
    const src = makeSource(file);
    const seen: string[] = [];
    src.onChange((k) => seen.push(k));
    src.startWatching();
    expect(src.current()).toBe('first-key'); // synchronous initial read
    const tmp = join(dir, '.relay.env.tmp');
    writeFileSync(tmp, 'RELAY_API_KEY=second-key\n', 'utf8');
    renameSync(tmp, file); // the sidecar's atomic-write shape
    await waitFor(() => src.current() === 'second-key');
    expect(seen).toEqual(['second-key']); // no spurious event for the initial read
  });

  it('keeps the last good key when the file goes missing or unparseable', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    writeFileSync(file, 'RELAY_API_KEY=good-key\n', 'utf8');
    const src = makeSource(file);
    src.startWatching();
    expect(src.current()).toBe('good-key');
    rmSync(file);
    await new Promise((r) => setTimeout(r, 150)); // a few poll cycles
    expect(src.current()).toBe('good-key');
    writeFileSync(file, 'garbage without a key\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(src.current()).toBe('good-key');
  });

  it('survives a parent directory that does not exist yet', async () => {
    const dir = makeDir();
    const nested = join(dir, 'not-yet');
    const file = join(nested, 'relay.env');
    const src = makeSource(file);
    src.startWatching(); // must not throw
    expect(src.current()).toBeNull();
    mkdirSync(nested);
    writeFileSync(file, 'RELAY_API_KEY=late-key\n', 'utf8');
    await waitFor(() => src.current() === 'late-key');
  });

  it('waitUntilAvailable resolves true on appearance and false on timeout', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    const src = makeSource(file);
    src.startWatching();
    const miss = await src.waitUntilAvailable(100);
    expect(miss).toBe(false);
    const hitP = src.waitUntilAvailable(3000);
    writeFileSync(file, 'RELAY_API_KEY=k\n', 'utf8');
    expect(await hitP).toBe(true);
  });
});
```

  and extend `apps/gateway/test/config.test.ts` (inside the existing `describe('loadConfig')`):

```ts
  it('accepts RELAY_API_KEY_FILE instead of RELAY_API_KEY', () => {
    const cfg = loadConfig({ ...base, RELAY_API_KEY: undefined, RELAY_API_KEY_FILE: '/run/companion/relay.env' });
    expect(cfg.relayApiKey).toBeUndefined();
    expect(cfg.relayApiKeyFile).toBe('/run/companion/relay.env');
    expect(cfg.keyBootWaitMs).toBe(15000);
  });

  it('explicit RELAY_API_KEY wins when both are set (back-compat)', () => {
    const cfg = loadConfig({ ...base, RELAY_API_KEY_FILE: '/run/companion/relay.env' });
    expect(cfg.relayApiKey).toBe('k');
    expect(cfg.relayApiKeyFile).toBeUndefined();
  });

  it('throws when neither key source is configured', () => {
    expect(() => loadConfig({ ...base, RELAY_API_KEY: undefined })).toThrow(/RELAY_API_KEY/);
  });
```

  The test file uses `mkdtempSync`/`mkdirSync`/`rmSync`/`renameSync`/`writeFileSync` (node:fs) and `tmpdir` (node:os). The gateway ships no `@types/node` (Pitfall 16) — check `apps/gateway/src/node-shims.d.ts` and add ONLY the missing declarations to its `declare module 'node:fs'` block:

```ts
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
```

  and, if absent, a `declare module 'node:os' { export function tmpdir(): string; }` block.

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/gateway test -- key-source`
Expected: FAIL — `Cannot find module '../src/key-source.js'`. Then `pnpm --filter @companion/gateway test -- config` → FAIL on the three new cases (throw on missing RELAY_API_KEY / `relayApiKeyFile` undefined).

- [ ] **Step 3: Implement** — `apps/gateway/src/key-source.ts`:

```ts
/**
 * File-sourced relay API key (turnkey stack): the bootstrap sidecar mints the
 * key at runtime and writes `relay.env` on the shared volume; this source
 * reads it, tolerates it being ABSENT AT BOOT (unlike FilePlayerStore, whose
 * constructor throws on a missing file — deliberately not reused), watches
 * for changes (parent-dir watch: atomic renames orphan a file watch —
 * player-store.ts precedent), and keeps the last good key when the file is
 * deleted or momentarily unparseable mid-rotation.
 *
 * fs.watch events are not guaranteed for writes arriving from ANOTHER
 * container on a shared volume, so a poll backstops the watcher; reload() is
 * idempotent and emits only on an actual key change, so watch+poll overlap
 * is harmless.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface KeySourceLog {
  warn(obj: object, msg: string): void;
}

/** Parse relay.env: first `RELAY_API_KEY=<value>` line wins; a file that is
 *  just a bare key (single line, no `=`) is accepted too. Null = no key. */
export function parseKeyFile(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^RELAY_API_KEY=(.+)$/.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  const trimmed = text.trim();
  if (trimmed !== '' && !trimmed.includes('=') && !trimmed.includes('\n')) return trimmed;
  return null;
}

export class ApiKeySource {
  private key: string | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchRetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(key: string) => void>();
  private log: KeySourceLog | null = null;

  constructor(
    private readonly filePath: string,
    private readonly opts: { pollMs?: number } = {},
  ) {}

  /** The last good key, or null when none has ever been read. */
  current(): string | null {
    return this.key;
  }

  /** Fires on every key CHANGE, including the first appearance. Callers that
   *  subscribe after startWatching() see no event for the boot-time read. */
  onChange(cb: (key: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Bounded boot wait (M18 pattern — never hard-block): true as soon as a
   *  key exists, false after timeoutMs (the gateway then starts degraded). */
  waitUntilAvailable(timeoutMs: number): Promise<boolean> {
    if (this.key !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.onChange(() => {
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /** Synchronous initial read + parent-dir watch + poll backstop. A missing
   *  file OR missing parent dir is fine — both are retried/polled. */
  startWatching(log?: KeySourceLog): void {
    if (log !== undefined) this.log = log;
    this.reload();
    this.tryWatch();
    if (this.watcher === null && this.watchRetryTimer === null) {
      this.watchRetryTimer = setInterval(() => {
        this.tryWatch();
        if (this.watcher !== null && this.watchRetryTimer !== null) {
          clearInterval(this.watchRetryTimer);
          this.watchRetryTimer = null;
        }
      }, 1_000);
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => this.reload(), this.opts.pollMs ?? 5_000);
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchRetryTimer !== null) {
      clearInterval(this.watchRetryTimer);
      this.watchRetryTimer = null;
    }
  }

  /** Re-read; keep last good on absence/unparseable; emit only on change. */
  reload(): void {
    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // absent (boot, or the mid-rotate rename window): keep last good
    }
    const parsed = parseKeyFile(text);
    if (parsed === null) {
      this.log?.warn({ file: this.filePath }, 'relay key file present but unparseable; keeping last good key');
      return;
    }
    if (parsed === this.key) return;
    this.key = parsed;
    for (const cb of [...this.listeners]) cb(parsed);
  }

  private tryWatch(): void {
    if (this.watcher !== null) return;
    const base = basename(this.filePath);
    try {
      this.watcher = watch(dirname(this.filePath), (_event: string, filename: string | null) => {
        if (filename !== null && filename !== base) return;
        if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 300);
      });
    } catch {
      this.watcher = null; // parent dir missing: retry timer + poll cover it
    }
  }
}
```

  and modify `apps/gateway/src/config.ts` — new interface fields + loadConfig body:

```ts
export interface GatewayConfig {
  port: number;
  relayUrl: string;
  /** Explicit key (back-compat). When both this and relayApiKeyFile are set,
   *  the explicit key wins and the file is ignored. */
  relayApiKey?: string;
  /** Turnkey: path to the sidecar-written relay.env, hot-reloaded via
   *  ApiKeySource; legitimately absent at boot. */
  relayApiKeyFile?: string;
  relayClientId: string;
  /** Bounded boot wait for the key file before starting degraded. */
  keyBootWaitMs: number;
  playersFile: string;
  /** Adapter used when the relay doc does not carry a system id. */
  defaultSystemId: string;
  /** Poll interval for the live-update fallback when relay SSE fails. */
  livePollMs: number;
  /** Enables /api/admin/* when set. Unset/empty = admin surface disabled. */
  adminPassword?: string;
}
```

```ts
  // inside loadConfig, replacing the relayApiKey line of the return object:
  const relayApiKey = env.RELAY_API_KEY;
  const relayApiKeyFile = env.RELAY_API_KEY_FILE;
  const hasExplicitKey = relayApiKey !== undefined && relayApiKey !== '';
  const hasKeyFile = relayApiKeyFile !== undefined && relayApiKeyFile !== '';
  if (!hasExplicitKey && !hasKeyFile) {
    throw new Error('missing required env var RELAY_API_KEY (or RELAY_API_KEY_FILE)');
  }
  return {
    port: int('PORT', 8090),
    relayUrl: required('RELAY_URL'),
    ...(hasExplicitKey ? { relayApiKey: relayApiKey as string } : {}),
    ...(hasKeyFile && !hasExplicitKey ? { relayApiKeyFile: relayApiKeyFile as string } : {}),
    relayClientId: required('RELAY_CLIENT_ID'),
    keyBootWaitMs: int('KEY_BOOT_WAIT_MS', 15_000),
    playersFile: required('PLAYERS_FILE'),
    defaultSystemId: env.DEFAULT_SYSTEM_ID ?? 'dnd5e',
    livePollMs: int('LIVE_POLL_MS', 3000),
    ...(env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== ''
      ? { adminPassword: env.ADMIN_PASSWORD }
      : {}),
  };
```

  `server.ts` bridge (temporary, replaced wholesale in Task 4): `relayApiKey` is now optional, and `RelayConfig.apiKey` is still a plain `string` until Task 2 — change server.ts line 27 to `apiKey: cfg.relayApiKey ?? '',` so the gateway still typechecks. Behavior is unchanged for every existing deployment (they all set RELAY_API_KEY).

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/gateway test` then `pnpm --filter @companion/gateway typecheck`
Expected: all gateway tests PASS (existing + new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/key-source.ts apps/gateway/src/config.ts apps/gateway/src/node-shims.d.ts apps/gateway/src/server.ts apps/gateway/test/key-source.test.ts apps/gateway/test/config.test.ts
git commit -m "feat(gateway): RELAY_API_KEY_FILE — file-sourced relay key with hot reload"
```

---

### Task 2: foundry-client — per-request `apiKey`/`clientId` providers

**Files:**
- Modify: `packages/foundry-client/src/index.ts:8-18` (RelayConfig), `:117-131` (url/headers)
- Test: `packages/foundry-client/test/client.test.ts` (extend — follow its global-mock-fetch idiom)

**Interfaces:**
- Produces (Tasks 3/4 consume):

```ts
export interface RelayConfig {
  baseUrl: string;
  /** Static key, or a provider re-read on EVERY request (turnkey hot-reload). */
  apiKey: string | (() => string);
  /** Static id, or a provider; may return '' while unresolved — requests then
   *  fail fast relay-side and callers degrade. Never cached in this class. */
  clientId: string | (() => string);
  log?: { warn(obj: object, msg: string): void };
}
```

Back-compat: plain strings behave exactly as today (all existing tests stay green untouched).

- [ ] **Step 1: Write the failing test** — append to `packages/foundry-client/test/client.test.ts`:

```ts
describe('FoundryRelayClient — provider-based credentials (turnkey)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-reads apiKey and clientId providers on every request', async () => {
    let apiKey = 'key-A';
    let clientId = 'fvtt_A';
    const client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: () => apiKey,
      clientId: () => clientId,
    });
    const ok = () => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ total: 0, clients: [] }), text: vi.fn() });
    mockFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());

    await client.listClients();
    apiKey = 'key-B';
    clientId = 'fvtt_B';
    await client.listClients();

    const [url1, init1] = mockFetch.mock.calls[0] as [string, Record<string, unknown>];
    const [url2, init2] = mockFetch.mock.calls[1] as [string, Record<string, unknown>];
    expect((init1.headers as Record<string, string>)['x-api-key']).toBe('key-A');
    expect((init2.headers as Record<string, string>)['x-api-key']).toBe('key-B');
    expect(url1).toContain('clientId=fvtt_A');
    expect(url2).toContain('clientId=fvtt_B');
  });

  it('an unresolved clientId provider ("") still issues the request with an empty param', async () => {
    const client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'k',
      clientId: () => '',
    });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ total: 0, clients: [] }), text: vi.fn() });
    await client.listClients();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('clientId=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @companion/foundry-client test`
Expected: FAIL — with `RelayConfig.apiKey: string` the function config is a type error (vitest surfaces the TS diagnostic) and, at runtime, the `x-api-key` header would be the function source, so the `toBe('key-A')` assertion fails.

- [ ] **Step 3: Implement** — in `packages/foundry-client/src/index.ts`, change the two RelayConfig fields:

```ts
  /** scoped API key (entity:read, entity:write, search, events:subscribe,
   *  clients:read, …). A function is re-read on every request so a rotated
   *  key takes effect without a restart (turnkey stack). */
  apiKey: string | (() => string);
  /** Foundry world client id, e.g. fvtt_3a9f1c2e4b7d8e0f. A function is
   *  re-read on every request; it may return '' while unresolved — the
   *  request then fails fast relay-side and the caller degrades. */
  clientId: string | (() => string);
```

  and add two private resolvers, used by `url()`/`headers()` (verify with a search that nothing else in the class reads `this.cfg.apiKey`/`this.cfg.clientId`):

```ts
  private apiKeyValue(): string {
    const k = this.cfg.apiKey;
    return typeof k === 'function' ? k() : k;
  }

  private clientIdValue(): string {
    const c = this.cfg.clientId;
    return typeof c === 'function' ? c() : c;
  }

  private url(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const u = new URL(path, this.cfg.baseUrl);
    u.searchParams.set('clientId', this.clientIdValue());
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': this.apiKeyValue(), ...extra };
  }
```

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/foundry-client test && pnpm --filter @companion/foundry-client typecheck`
Expected: PASS (new + all existing string-config tests). Cross-package gate — the gateway compiles foundry-client source under its own tsconfig: `pnpm --filter @companion/gateway typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts
git commit -m "feat(client): per-request apiKey/clientId providers (back-compat)"
```

---

### Task 3: Gateway `RELAY_CLIENT_ID=auto` — `ClientIdResolver`

**Files:**
- Create: `apps/gateway/src/client-id-resolver.ts`
- Modify: `apps/gateway/src/config.ts` (RELAY_CLIENT_ID normalization — the `relayClientId: required('RELAY_CLIENT_ID')` line from Task 1's version)
- Test: `apps/gateway/test/client-id-resolver.test.ts` (new), `apps/gateway/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `RelayClientInfo` (exported by `@companion/foundry-client`: `{ clientId: string; worldId: string; worldTitle: string; foundryVersion: string; systemId: string; isOnline: boolean }`).
- Produces (Task 4's server.ts and Task 5's healthz consume):

```ts
export type ResolveReason =
  | 'explicit' | 'resolved' | 'key-unavailable' | 'relay-unreachable'
  | 'no-world-online' | 'multiple-worlds-online' | 'world-offline';

/** Client-safe world state for /healthz — carries NO clientId, ever. */
export interface WorldHealth {
  state: 'online' | 'waiting' | 'blocked';
  worldTitle?: string;
  reason?: Exclude<ResolveReason, 'explicit' | 'resolved'>;
}

export interface ResolverDeps {
  listClients(): Promise<RelayClientInfo[]>;
  hasKey(): boolean;              // false while the file-sourced key is absent
  probeMs?: number;               // default 5000
  probeTimeoutMs?: number;        // default 3000 (M18 bound)
  log?: { warn(obj: object, msg: string): void };
}

export class ClientIdResolver {
  constructor(clientIdConfig: string /* 'auto' or explicit fvtt_… */, deps: ResolverDeps);
  current(): string;                                // '' while unresolved
  onChange(cb: (clientId: string) => void): () => void;
  healthView(): WorldHealth | null;                 // null in explicit mode
  start(): void;                                    // probe loop (auto mode only)
  stop(): void;
  probeOnce(): Promise<void>;                       // one bounded pass; tests drive this
}
```

**Policy (explicit, from the spec — encode verbatim in the class doc comment):** a wrong/offline clientId STALLS relay requests rather than erroring, so resolution is driven only by this bounded probe. `0` online → degrade + report `no-world-online`. `>1` online → REFUSE and report `multiple-worlds-online` (never pick — orphaned pairings exist; the operator sets an explicit `RELAY_CLIENT_ID`). Exactly `1` → resolve, cache `{worldId, clientId, worldTitle}`. On re-probe with a cache: follow the SAME `worldId` only — a fresh clientId for the same worldId (re-pair after a relay-DB reset) is adopted + emitted; a DIFFERENT world being the only one online is NEVER adopted (`world-offline`). The cache is process-lifetime; a gateway restart re-resolves from scratch (documented, intentional — single-world stacks).

- [ ] **Step 1: Write the failing tests** — `apps/gateway/test/client-id-resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RelayClientInfo } from '@companion/foundry-client';
import { ClientIdResolver } from '../src/client-id-resolver.js';

function info(clientId: string, worldId: string, isOnline: boolean, worldTitle = worldId): RelayClientInfo {
  return { clientId, worldId, worldTitle, foundryVersion: '13.351', systemId: 'dnd5e', isOnline };
}

function makeResolver(opts: {
  mode?: string;
  clients?: () => Promise<RelayClientInfo[]>;
  hasKey?: () => boolean;
}) {
  const changes: string[] = [];
  const resolver = new ClientIdResolver(opts.mode ?? 'auto', {
    listClients: opts.clients ?? (async () => []),
    hasKey: opts.hasKey ?? (() => true),
    probeTimeoutMs: 100,
  });
  resolver.onChange((id) => changes.push(id));
  return { resolver, changes };
}

describe('ClientIdResolver — explicit mode (back-compat)', () => {
  it('returns the explicit id, never probes, healthView is null', async () => {
    let called = 0;
    const { resolver, changes } = makeResolver({
      mode: 'fvtt_explicit',
      clients: async () => {
        called++;
        return [];
      },
    });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_explicit');
    expect(called).toBe(0);
    expect(resolver.healthView()).toBeNull();
    expect(changes).toEqual([]);
  });
});

describe('ClientIdResolver — auto mode', () => {
  it('0 online worlds: degrades, reports no-world-online, current() is empty', async () => {
    const { resolver, changes } = makeResolver({ clients: async () => [info('fvtt_a', 'w1', false)] });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('');
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'no-world-online' });
    expect(changes).toEqual([]);
  });

  it('exactly 1 online: resolves, caches, emits once', async () => {
    const { resolver, changes } = makeResolver({
      clients: async () => [info('fvtt_a', 'w1', true, 'My World'), info('fvtt_b', 'w2', false)],
    });
    await resolver.probeOnce();
    await resolver.probeOnce(); // idempotent re-probe
    expect(resolver.current()).toBe('fvtt_a');
    expect(resolver.healthView()).toEqual({ state: 'online', worldTitle: 'My World' });
    expect(changes).toEqual(['fvtt_a']);
  });

  it('>1 online: refuses, reports multiple-worlds-online, resolves nothing', async () => {
    const { resolver, changes } = makeResolver({
      clients: async () => [info('fvtt_a', 'w1', true), info('fvtt_b', 'w2', true)],
    });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('');
    expect(resolver.healthView()).toEqual({ state: 'blocked', reason: 'multiple-worlds-online' });
    expect(changes).toEqual([]);
  });

  it('never switches worlds: a different single online world is not adopted', async () => {
    let clients = [info('fvtt_a', 'w1', true, 'World One')];
    const { resolver, changes } = makeResolver({ clients: async () => clients });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_a');
    clients = [info('fvtt_x', 'wOTHER', true, 'Impostor')]; // w1 gone, another world online
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_a'); // sticky — never switched
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'world-offline', worldTitle: 'World One' });
    expect(changes).toEqual(['fvtt_a']);
  });

  it('follows a NEW clientId for the SAME worldId (re-pair) and emits', async () => {
    let clients = [info('fvtt_a', 'w1', true)];
    const { resolver, changes } = makeResolver({ clients: async () => clients });
    await resolver.probeOnce();
    clients = [info('fvtt_repaired', 'w1', true)];
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_repaired');
    expect(changes).toEqual(['fvtt_a', 'fvtt_repaired']);
  });

  it('key unavailable: reports without calling the relay', async () => {
    let called = 0;
    const { resolver } = makeResolver({
      hasKey: () => false,
      clients: async () => {
        called++;
        return [];
      },
    });
    await resolver.probeOnce();
    expect(called).toBe(0);
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'key-unavailable' });
  });

  it('bounded probe: a hanging listClients degrades to relay-unreachable within the budget', async () => {
    const { resolver } = makeResolver({ clients: () => new Promise(() => undefined) });
    const start = Date.now();
    await resolver.probeOnce();
    expect(Date.now() - start).toBeLessThan(1000); // probeTimeoutMs=100 + slack
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'relay-unreachable' });
  });

  it('a throwing listClients degrades to relay-unreachable', async () => {
    const { resolver } = makeResolver({
      clients: async () => {
        throw new Error('boom');
      },
    });
    await resolver.probeOnce();
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'relay-unreachable' });
  });
});
```

  and extend `apps/gateway/test/config.test.ts`:

```ts
  it('normalizes RELAY_CLIENT_ID: unset/empty/auto -> "auto"; explicit id kept', () => {
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: undefined }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: '' }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base, RELAY_CLIENT_ID: 'auto' }).relayClientId).toBe('auto');
    expect(loadConfig({ ...base }).relayClientId).toBe('fvtt_x'); // back-compat
  });
```

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/gateway test -- client-id-resolver`
Expected: FAIL — `Cannot find module '../src/client-id-resolver.js'`; the config case fails with `missing required env var RELAY_CLIENT_ID`.

- [ ] **Step 3: Implement** — `apps/gateway/src/client-id-resolver.ts`:

```ts
/**
 * RELAY_CLIENT_ID=auto (turnkey): resolve the world clientId from the relay's
 * single online world, cache it BY WORLD ID, and never silently switch worlds
 * (a silent switch would send player writes into the wrong world). A wrong or
 * offline clientId makes relay requests STALL rather than error
 * (docs/RELAY.md), so resolution is driven by this bounded probe loop — never
 * by organic request failure.
 *
 * Policy: 0 online -> degrade + report. >1 online -> REFUSE + report (an
 * orphaned second pairing is a real state; the operator disambiguates with an
 * explicit RELAY_CLIENT_ID). Exactly 1 -> resolve + cache. With a cache: only
 * ever follow the SAME worldId; a fresh clientId for that worldId (re-pair)
 * is adopted and emitted; a different world is never adopted mid-run. The
 * cache is process-lifetime — a restart re-resolves from scratch.
 */
import type { RelayClientInfo } from '@companion/foundry-client';

export type ResolveReason =
  | 'explicit'
  | 'resolved'
  | 'key-unavailable'
  | 'relay-unreachable'
  | 'no-world-online'
  | 'multiple-worlds-online'
  | 'world-offline';

/** Client-safe world state for /healthz — carries NO clientId, ever. */
export interface WorldHealth {
  state: 'online' | 'waiting' | 'blocked';
  worldTitle?: string;
  reason?: Exclude<ResolveReason, 'explicit' | 'resolved'>;
}

export interface ResolverDeps {
  listClients(): Promise<RelayClientInfo[]>;
  /** False while the file-sourced key has not appeared yet. */
  hasKey(): boolean;
  /** Probe interval. Default 5000. */
  probeMs?: number;
  /** Bound for each listClients call (M18 pattern). Default 3000. */
  probeTimeoutMs?: number;
  log?: { warn(obj: object, msg: string): void };
}

export class ClientIdResolver {
  private readonly explicitId: string | null;
  private cache: { worldId: string; clientId: string; worldTitle: string } | null = null;
  private reason: ResolveReason;
  private readonly listeners = new Set<(clientId: string) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(
    clientIdConfig: string,
    private readonly deps: ResolverDeps,
  ) {
    this.explicitId = clientIdConfig === 'auto' ? null : clientIdConfig;
    this.reason = this.explicitId !== null ? 'explicit' : 'no-world-online';
  }

  /** The clientId requests should use RIGHT NOW; '' while unresolved (the
   *  relay rejects it fast; callers already degrade on failed requests). */
  current(): string {
    if (this.explicitId !== null) return this.explicitId;
    return this.cache?.clientId ?? '';
  }

  /** Fires whenever current() changes value (first resolve + re-pairs). */
  onChange(cb: (clientId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Null in explicit mode (nothing to report); /healthz omits the field. */
  healthView(): WorldHealth | null {
    if (this.explicitId !== null) return null;
    switch (this.reason) {
      case 'resolved':
        return { state: 'online', worldTitle: (this.cache as { worldTitle: string }).worldTitle };
      case 'multiple-worlds-online':
        return { state: 'blocked', reason: 'multiple-worlds-online' };
      case 'world-offline':
        return {
          state: 'waiting',
          reason: 'world-offline',
          ...(this.cache !== null ? { worldTitle: this.cache.worldTitle } : {}),
        };
      case 'key-unavailable':
      case 'relay-unreachable':
      case 'no-world-online':
        return { state: 'waiting', reason: this.reason };
      default:
        return { state: 'waiting', reason: 'no-world-online' };
    }
  }

  start(): void {
    if (this.explicitId !== null || this.timer !== null) return;
    void this.probeOnce();
    this.timer = setInterval(() => void this.probeOnce(), this.deps.probeMs ?? 5_000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One bounded resolution pass (doubles as the world health probe).
   *  Concurrent calls coalesce: a pass already in flight makes this a no-op. */
  async probeOnce(): Promise<void> {
    if (this.explicitId !== null || this.probing) return;
    this.probing = true;
    try {
      if (!this.deps.hasKey()) {
        this.reason = 'key-unavailable';
        return;
      }
      let clients: RelayClientInfo[] | null;
      try {
        clients = await Promise.race([
          this.deps.listClients(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), this.deps.probeTimeoutMs ?? 3_000)),
        ]);
      } catch (err) {
        this.deps.log?.warn({ err: (err as Error).message }, 'clientId probe: relay unreachable');
        this.reason = 'relay-unreachable';
        return;
      }
      if (clients === null) {
        this.reason = 'relay-unreachable';
        return;
      }
      const online = clients.filter((c) => c.isOnline === true);
      if (this.cache !== null) {
        // Never switch worlds: only ever follow the SAME worldId, even if a
        // different world is the only one online now.
        const same = online.find((c) => c.worldId === (this.cache as { worldId: string }).worldId);
        if (same === undefined) {
          this.reason = 'world-offline';
          return;
        }
        if (same.clientId !== this.cache.clientId) {
          // Same world re-paired under a fresh clientId (relay DB reset /
          // re-pair) — following it is not a world switch.
          this.cache = { worldId: same.worldId, clientId: same.clientId, worldTitle: same.worldTitle };
          this.emit(same.clientId);
        }
        this.reason = 'resolved';
        return;
      }
      if (online.length === 0) {
        this.reason = 'no-world-online';
        return;
      }
      if (online.length > 1) {
        this.deps.log?.warn({ count: online.length }, 'clientId probe: multiple worlds online; refusing to pick');
        this.reason = 'multiple-worlds-online';
        return;
      }
      const only = online[0] as RelayClientInfo;
      this.cache = { worldId: only.worldId, clientId: only.clientId, worldTitle: only.worldTitle };
      this.reason = 'resolved';
      this.emit(only.clientId);
    } finally {
      this.probing = false;
    }
  }

  private emit(clientId: string): void {
    for (const cb of [...this.listeners]) cb(clientId);
  }
}
```

  and in `apps/gateway/src/config.ts`, replace `relayClientId: required('RELAY_CLIENT_ID'),` with:

```ts
    // 'auto' (turnkey; also the default when unset/empty) or an explicit
    // fvtt_… id (back-compat — behaves exactly as before).
    relayClientId:
      env.RELAY_CLIENT_ID === undefined || env.RELAY_CLIENT_ID === '' || env.RELAY_CLIENT_ID === 'auto'
        ? 'auto'
        : env.RELAY_CLIENT_ID,
```

  Update the `relayClientId` doc comment in `GatewayConfig` accordingly (`/** 'auto' or an explicit fvtt_… world client id. */`).

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/gateway test && pnpm --filter @companion/gateway typecheck`
Expected: PASS. (Note: `loadConfig` no longer throws on a missing `RELAY_CLIENT_ID` — that is intentional and covered by the new normalization test; no existing test asserted that throw.)

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/client-id-resolver.ts apps/gateway/src/config.ts apps/gateway/test/client-id-resolver.test.ts apps/gateway/test/config.test.ts
git commit -m "feat(gateway): RELAY_CLIENT_ID=auto — bounded probe resolution, cache by worldId"
```

---

### Task 4: SSE re-subscription on identity change + turnkey server wiring

**Files:**
- Modify: `apps/gateway/src/live.ts` (add `LiveManager.restartStream()` after `stopAll()`, ~line 191), `apps/gateway/src/encounters.ts` (add `EncounterManager.restartStream()` after `stop()`, ~line 137), `apps/gateway/src/app.ts:132-163` (GatewayDeps) + `:385-387` (cleanup registries) + gm-rolls route `:614-672`, `apps/gateway/src/server.ts` (full rewrite)
- Test: `apps/gateway/test/identity-restart.test.ts` (new)

**Interfaces:**
- Consumes: `ApiKeySource` (Task 1), provider-typed `RelayConfig` (Task 2), `ClientIdResolver` (Task 3), FakeRelay's `hookSubscribers`/`hookSubscriptions`/`rollSubscribers`/`getEncountersCalls` (existing `apps/gateway/test/fakes.ts`).
- Produces:

```ts
// live.ts
class LiveManager { restartStream(): void }        // abort + re-open the shared hooks stream
// encounters.ts
class EncounterManager { restartStream(): void }   // abort loop, re-seed, new subscribe loop
// app.ts — GatewayDeps gains:
//   relayIdentityChanged?: (cb: () => void) => () => void;
// buildApp reaction on fire: live.restartStream() + close all gm-rolls SSE
// connections (their relay-side /rolls/subscribe aborts; browser EventSources
// reconnect and re-subscribe under the new identity).
```

Why all three relay-side streams: they capture the clientId/key at fetch time (`readSse` builds the URL once per connection). LiveManager's hooks stream and EncounterManager's hooks stream are process-lifetime loops — they must be aborted and re-opened in place. The gm-rolls relay stream is per-SSE-client (`app.ts:665-670`); closing the client connection runs its `cleanup()`, which aborts the relay stream, and the browser's EventSource auto-reconnects — re-subscribing with the new identity. EncounterManager is restarted by server.ts (it owns the manager); buildApp handles its own two.

- [ ] **Step 1: Write the failing tests** — `apps/gateway/test/identity-restart.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { LiveManager } from '../src/live.js';
import { EncounterManager } from '../src/encounters.js';
import { createRegistry } from '../src/registry.js';
import { sha256Hex, type Player } from '../src/players.js';
import { FakeRelay, fakeAdapter, memoryPlayers } from './fakes.js';

const GM_TOKEN = 'gm-token';
const GM: Player = { name: 'Gm', tokenHash: sha256Hex(GM_TOKEN), actorIds: ['a1'], gm: true };

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('LiveManager.restartStream', () => {
  it('aborts the open hooks stream and opens a fresh one; no-op when idle', async () => {
    const relay = new FakeRelay();
    const live = new LiveManager({
      pollMs: 10_000,
      fetchSheetJson: async () => '{}',
      subscribeHooks: (hooks, onEvent, signal) => relay.subscribeHooks(hooks, onEvent, signal),
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    live.restartStream(); // idle: must not throw, must not open anything
    expect(relay.hookSubscriptions).toHaveLength(0);

    const detach = live.attach('a1', () => undefined, '{}');
    await waitFor(() => relay.hookSubscribers.size === 1);
    live.restartStream();
    await waitFor(() => relay.hookSubscriptions.length === 2);
    expect(relay.hookSubscribers.size).toBe(1); // old aborted, exactly one live
    detach();
    await waitFor(() => relay.hookSubscribers.size === 0);
  });
});

describe('EncounterManager.restartStream', () => {
  it('re-seeds and re-subscribes; no-op before start()', async () => {
    const relay = new FakeRelay();
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 200, reconnectMinMs: 10, reconnectMaxMs: 20 });
    mgr.restartStream(); // not started: no-op
    expect(relay.hookSubscriptions).toHaveLength(0);

    await mgr.start();
    await waitFor(() => relay.hookSubscribers.size === 1);
    const seedsBefore = relay.getEncountersCalls.length;
    mgr.restartStream();
    await waitFor(() => relay.hookSubscriptions.length === 2);
    expect(relay.getEncountersCalls.length).toBeGreaterThan(seedsBefore); // re-seeded
    expect(relay.hookSubscribers.size).toBe(1);
    mgr.stop();
  });
});

describe('buildApp — relayIdentityChanged', () => {
  it('closes gm-rolls SSE connections so clients re-subscribe under the new identity', async () => {
    const relay = new FakeRelay();
    let fire: () => void = () => undefined;
    const app = buildApp({
      relay,
      players: memoryPlayers([GM]),
      registry: createRegistry([fakeAdapter]),
      relayIdentityChanged: (cb) => {
        fire = cb;
        return () => undefined;
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/gm/rolls/events?token=${GM_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => relay.rollSubscribers.size === 1);
    fire();
    await waitFor(() => relay.rollSubscribers.size === 0); // relay-side stream aborted
    await app.close();
  });

  it('restarts the shared actor-hooks stream while actor SSE clients stay connected', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', {
      _id: 'a1', name: 'Anna', type: 'character', systemId: 'fake',
      system: { hp: { value: 10, max: 10 }, ac: 15 }, items: [],
    });
    let fire: () => void = () => undefined;
    const app = buildApp({
      relay,
      players: memoryPlayers([GM]),
      registry: createRegistry([fakeAdapter]),
      liveReconnectMinMs: 10,
      liveReconnectMaxMs: 20,
      relayIdentityChanged: (cb) => {
        fire = cb;
        return () => undefined;
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/actors/a1/events?token=${GM_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => relay.hookSubscribers.size === 1);
    const before = relay.hookSubscriptions.length;
    fire();
    await waitFor(() => relay.hookSubscriptions.length === before + 1); // fresh stream
    expect(relay.hookSubscribers.size).toBe(1);
    await app.close();
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/gateway test -- identity-restart`
Expected: FAIL — `restartStream is not a function` / `relayIdentityChanged` unknown dep (TS error via vitest).

- [ ] **Step 3: Implement the manager methods.** In `apps/gateway/src/live.ts`, after `stopAll()`:

```ts
  /** Abort + re-open the shared hooks stream — the relay identity (api key
   *  or clientId) changed, so the open stream belongs to the old identity.
   *  No-op when idle: the next attach opens a fresh stream anyway. */
  restartStream(): void {
    if (this.streamAc === null) return;
    this.streamAc.abort();
    this.streamAc = null;
    this.streamUp = false;
    this.ensureStream();
  }
```

  In `apps/gateway/src/encounters.ts`, after `stop()`:

```ts
  /** Abort + restart the hooks loop and re-seed — the relay identity (api
   *  key or clientId) changed, so both the open stream and any cached combat
   *  may belong to the wrong identity. No-op before start()/after stop(). */
  restartStream(): void {
    if (this.loopAc === null) return;
    this.loopAc.abort();
    this.loopAc = new AbortController();
    void this.reseed();
    void this.subscribeLoop(this.loopAc);
  }
```

- [ ] **Step 4: Implement the buildApp wiring.** In `apps/gateway/src/app.ts`:

  (1) `GatewayDeps` gains (after `customItemTimeoutMs`):

```ts
  /** Turnkey: subscribe to relay identity changes (key rotated / clientId
   *  re-resolved). On fire, buildApp restarts its relay-side streams:
   *  LiveManager's hooks stream is aborted+reopened, and every gm-rolls SSE
   *  connection is closed (its relay-side /rolls/subscribe aborts; browser
   *  EventSources reconnect and re-subscribe under the new identity). The
   *  EncounterManager's stream is restarted by server.ts, which owns it.
   *  Returns an unsubscribe function. */
  relayIdentityChanged?: (cb: () => void) => () => void;
```

  (2) next to `const sseCleanups = new Set<() => void>();` add:

```ts
  // gm-rolls SSE connections hold a relay-side /rolls/subscribe opened with
  // the connection-time identity; tracked separately so an identity change
  // can close exactly these (see relayIdentityChanged).
  const rollStreamCleanups = new Set<() => void>();
```

  and directly below, the subscription (LiveManager `live` is already defined above this point):

```ts
  if (deps.relayIdentityChanged !== undefined) {
    const unsubscribe = deps.relayIdentityChanged(() => {
      app.log.warn({}, 'relay identity changed; restarting relay-side streams');
      live.restartStream();
      for (const cleanup of [...rollStreamCleanups]) cleanup();
    });
    app.addHook('onClose', async () => unsubscribe());
  }
```

  (3) in the gm-rolls route (`/api/gm/rolls/events`): after the existing `const cleanup = (): void => { ... }` definition, register it — add `rollStreamCleanups.add(cleanup);` right after the definition, and inside `cleanup()` (after `if (done) return; done = true;`) add `rollStreamCleanups.delete(cleanup);`.

- [ ] **Step 5: Rewrite `apps/gateway/src/server.ts`** (full replacement — this is the whole turnkey wiring):

```ts
/**
 * Production bootstrap: env config -> players.yaml -> real relay client ->
 * default adapter registry -> Fastify listen. Secrets (token, relay key)
 * are redacted from structured logs and never reach response bodies.
 *
 * Turnkey additions: the relay key may be file-sourced (RELAY_API_KEY_FILE,
 * hot-reloaded), the clientId may be auto-resolved (RELAY_CLIENT_ID=auto),
 * and any identity change (rotated key / re-resolved clientId) restarts
 * every relay-side stream. All boot waits are bounded — the gateway starts
 * degraded and converges (Global Constraints: converge, never restart).
 */
import { FoundryRelayClient, type RelayClientInfo } from '@companion/foundry-client';
import { loadConfig, redactUrlToken } from './config.js';
import { createDefaultRegistry } from './registry.js';
import { buildApp } from './app.js';
import { EncounterManager } from './encounters.js';
import { FilePlayerStore } from './player-store.js';
import { ApiKeySource } from './key-source.js';
import { ClientIdResolver } from './client-id-resolver.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new FilePlayerStore(cfg.playersFile);

  // The relay client and manager must exist before buildApp (the manager
  // registers the /api/encounter* routes only when present), but their
  // logger should be the real app's once built — a mutable indirection
  // bridges the ordering.
  let logRef: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void } = {
    warn: () => undefined,
    debug: () => undefined,
  };

  // Key source: explicit RELAY_API_KEY wins (back-compat); otherwise the
  // sidecar-written file, legitimately absent at boot.
  const keySource = cfg.relayApiKeyFile !== undefined ? new ApiKeySource(cfg.relayApiKeyFile) : null;
  keySource?.startWatching({ warn: (obj, msg) => logRef.warn(obj, msg) });
  const apiKey = (): string => cfg.relayApiKey ?? keySource?.current() ?? '';

  // clientId provider <-> resolver cycle: the resolver probes via the relay
  // client, whose clientId provider reads the resolver. listClients ignores
  // the clientId param, so the late-bound reference is safe — providers are
  // only invoked per request, after both objects exist.
  let resolverRef: ClientIdResolver | null = null;
  const relay = new FoundryRelayClient({
    baseUrl: cfg.relayUrl,
    apiKey,
    clientId: () => resolverRef?.current() ?? '',
    log: { warn: (obj, msg) => logRef.warn(obj, msg) },
  });
  const resolver = new ClientIdResolver(cfg.relayClientId, {
    listClients: () => relay.listClients() as Promise<RelayClientInfo[]>,
    hasKey: () => apiKey() !== '',
    log: { warn: (obj, msg) => logRef.warn(obj, msg) },
  });
  resolverRef = resolver;

  const encounters = new EncounterManager({
    relay,
    log: {
      warn: (obj, msg) => logRef.warn(obj, msg),
      debug: (obj, msg) => logRef.debug(obj, msg),
    },
  });

  // Identity fan-out: a rotated key or a (re)resolved clientId restarts
  // every relay-side stream (buildApp handles LiveManager + gm-rolls; the
  // EncounterManager is restarted here — server owns its lifecycle).
  const identityListeners = new Set<() => void>();
  const fireIdentityChanged = (): void => {
    for (const cb of [...identityListeners]) cb();
  };
  keySource?.onChange(() => fireIdentityChanged());
  resolver.onChange(() => fireIdentityChanged());
  identityListeners.add(() => encounters.restartStream());

  const app = buildApp({
    relay,
    players: store,
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    livePollMs: cfg.livePollMs,
    encounters,
    relayIdentityChanged: (cb) => {
      identityListeners.add(cb);
      return () => identityListeners.delete(cb);
    },
    ...(cfg.adminPassword !== undefined ? { admin: { password: cfg.adminPassword, store } } : {}),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.query.token',
          'token',
          '*.token',
          'apiKey',
          '*.apiKey',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req(req: { method?: string; url?: string; ip?: string }) {
          return {
            method: req.method,
            url: typeof req.url === 'string' ? redactUrlToken(req.url) : req.url,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  logRef = {
    warn: (obj, msg) => app.log.warn(obj, msg),
    debug: (obj, msg) => app.log.debug(obj, msg),
  };
  store.startWatching({ warn: (obj, msg) => app.log.warn(obj, msg) });

  const close = async (): Promise<void> => {
    store.stopWatching();
    keySource?.stopWatching();
    resolver.stop();
    encounters.stop();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  // Bounded boot wait: with a file-sourced key, give the sidecar a moment
  // before serving degraded (M18 pattern — never hard-block).
  if (keySource !== null && cfg.relayApiKey === undefined) {
    const ok = await keySource.waitUntilAvailable(cfg.keyBootWaitMs);
    if (!ok) {
      app.log.warn({ waitedMs: cfg.keyBootWaitMs }, 'relay key file not present yet; starting degraded');
    }
  }

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  resolver.start();
  await encounters.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gateway failed to start:', (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 6: Run tests, see them pass**

Run: `pnpm --filter @companion/gateway test && pnpm --filter @companion/gateway typecheck`
Expected: PASS — all existing suites (app, live, encounters, admin, players, config, registry) plus identity-restart.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/live.ts apps/gateway/src/encounters.ts apps/gateway/src/app.ts apps/gateway/src/server.ts apps/gateway/test/identity-restart.test.ts
git commit -m "feat(gateway): restart relay-side streams on relay identity change"
```

---

### Task 5: `/healthz` — world state + sidecar status merge

**Files:**
- Create: `apps/gateway/src/status-file.ts`
- Modify: `apps/gateway/src/app.ts` (GatewayDeps + the `/healthz` route, currently `:459-468`), `apps/gateway/src/config.ts` (add `statusFile?: string`), `apps/gateway/src/server.ts` (pass the two new deps), `apps/gateway/test/fakes.ts:62-69` (add `hangListClients`)
- Test: `apps/gateway/test/healthz-status.test.ts` (new)

**Interfaces:**
- Consumes: `WorldHealth` (Task 3).
- Produces:

```ts
// status-file.ts
export interface BootstrapStatusView {
  phase: string;
  detail?: string;
  error?: { class: string; message: string } | null;
  updatedAt?: string;
}
export function readBootstrapStatus(filePath: string): BootstrapStatusView | null;

// app.ts — GatewayDeps gains:
//   worldStatus?: () => WorldHealth | null;              // null -> field omitted
//   bootstrapStatus?: () => BootstrapStatusView | null;  // null -> field omitted
//   healthTimeoutMs?: number;                            // default 3000
// /healthz response: { ok: true, relay: 'connected'|'disconnected',
//                      world?: WorldHealth, bootstrap?: BootstrapStatusView }
```

Rules: the OLD response shape (`{ok, relay}`) is preserved bit-for-bit when the new deps are absent (existing `app.test.ts` healthz assertions use `toEqual` and must stay green untouched). The relay probe is now BOUNDED (Pitfall 11). `readBootstrapStatus` is a strict field WHITELIST (Pitfall 12): unknown fields in status.json are dropped, non-string `phase` ⇒ null, malformed JSON ⇒ null — nothing on the shared volume can inject content into the unauthenticated health surface. `/healthz` never contains a clientId or key in any branch.

- [ ] **Step 1: Write the failing tests** — `apps/gateway/test/healthz-status.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readBootstrapStatus } from '../src/status-file.js';
import { createRegistry } from '../src/registry.js';
import { FakeRelay, fakeAdapter, memoryPlayers } from './fakes.js';

const dirs: string[] = [];
function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'statusf-'));
  dirs.push(dir);
  const f = join(dir, 'status.json');
  writeFileSync(f, content, 'utf8');
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readBootstrapStatus — whitelist', () => {
  it('passes only whitelisted fields through', () => {
    const f = tmpFile(
      JSON.stringify({
        phase: 'waiting-world',
        detail: 'create your world',
        error: null,
        updatedAt: '2026-07-15T12:00:00Z',
        apiKey: 'LEAKED-KEY',
        clientId: 'fvtt_LEAKED',
        anything: { nested: true },
      }),
    );
    expect(readBootstrapStatus(f)).toEqual({
      phase: 'waiting-world',
      detail: 'create your world',
      error: null,
      updatedAt: '2026-07-15T12:00:00Z',
    });
  });
  it('null on absent file, malformed JSON, or missing phase', () => {
    expect(readBootstrapStatus(join(tmpdir(), 'does-not-exist-xyz', 'status.json'))).toBeNull();
    expect(readBootstrapStatus(tmpFile('{not json'))).toBeNull();
    expect(readBootstrapStatus(tmpFile(JSON.stringify({ detail: 'no phase' })))).toBeNull();
  });
  it('error object is itself whitelisted', () => {
    const f = tmpFile(
      JSON.stringify({ phase: 'error', error: { class: 'RelayAuthError', message: 'login failed', stack: 'SECRET' } }),
    );
    expect(readBootstrapStatus(f)).toEqual({ phase: 'error', error: { class: 'RelayAuthError', message: 'login failed' } });
  });
});

describe('/healthz — merged turnkey view', () => {
  function makeApp(opts: { relay?: FakeRelay; worldStatus?: () => import('../src/client-id-resolver.js').WorldHealth | null; statusFile?: string; healthTimeoutMs?: number } = {}) {
    const relay = opts.relay ?? new FakeRelay();
    return {
      relay,
      app: buildApp({
        relay,
        players: memoryPlayers([]),
        registry: createRegistry([fakeAdapter]),
        ...(opts.worldStatus !== undefined ? { worldStatus: opts.worldStatus } : {}),
        ...(opts.statusFile !== undefined
          ? { bootstrapStatus: () => readBootstrapStatus(opts.statusFile as string) }
          : {}),
        ...(opts.healthTimeoutMs !== undefined ? { healthTimeoutMs: opts.healthTimeoutMs } : {}),
      }),
    };
  }

  it('keeps the exact legacy shape when no turnkey deps are wired', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, relay: 'connected' });
  });

  it('merges world + bootstrap fields and never exposes a clientId', async () => {
    const f = tmpFile(JSON.stringify({ phase: 'online', detail: 'world online', error: null, updatedAt: 'x' }));
    const { app } = makeApp({
      worldStatus: () => ({ state: 'online', worldTitle: 'My World' }),
      statusFile: f,
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({
      ok: true,
      relay: 'connected',
      world: { state: 'online', worldTitle: 'My World' },
      bootstrap: { phase: 'online', detail: 'world online', error: null, updatedAt: 'x' },
    });
    expect(res.body).not.toContain('fvtt_');
  });

  it('omits world/bootstrap when their providers return null', async () => {
    const { app } = makeApp({ worldStatus: () => null, statusFile: join(tmpdir(), 'nope', 'status.json') });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, relay: 'connected' });
  });

  it('bounds the relay probe: a hanging listClients reports disconnected within the budget', async () => {
    const relay = new FakeRelay();
    relay.hangListClients = true;
    const { app } = makeApp({ relay, healthTimeoutMs: 100 });
    const start = Date.now();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(res.json()).toEqual({ ok: true, relay: 'disconnected' });
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/gateway test -- healthz-status`
Expected: FAIL — `Cannot find module '../src/status-file.js'`; unknown `worldStatus`/`bootstrapStatus`/`healthTimeoutMs`/`hangListClients`.

- [ ] **Step 3: Implement.** `apps/gateway/src/status-file.ts`:

```ts
/**
 * Whitelist reader for the bootstrap sidecar's status.json (shared volume).
 * /healthz is unauthenticated, so ONLY known fields pass through — nothing
 * written to the shared volume (by the sidecar or anyone with volume access)
 * can inject arbitrary content, keys, or a clientId into the health surface.
 * Absent/malformed file -> null (the caller omits the field).
 */
import { readFileSync } from 'node:fs';

export interface BootstrapStatusView {
  phase: string;
  detail?: string;
  error?: { class: string; message: string } | null;
  updatedAt?: string;
}

export function readBootstrapStatus(filePath: string): BootstrapStatusView | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const rec = doc as Record<string, unknown>;
  if (typeof rec.phase !== 'string' || rec.phase === '') return null;
  const out: BootstrapStatusView = { phase: rec.phase };
  if (typeof rec.detail === 'string') out.detail = rec.detail;
  if (typeof rec.updatedAt === 'string') out.updatedAt = rec.updatedAt;
  if (rec.error === null) {
    out.error = null;
  } else if (rec.error !== undefined && typeof rec.error === 'object' && !Array.isArray(rec.error)) {
    const e = rec.error as Record<string, unknown>;
    if (typeof e.class === 'string' && typeof e.message === 'string') {
      out.error = { class: e.class, message: e.message };
    }
  }
  return out;
}
```

  In `apps/gateway/test/fakes.ts`, add to FakeRelay (next to `listClientsError`):

```ts
  /** When true, listClients never settles (turnkey: exercises the bounded
   *  /healthz probe and the resolver's probe timeout). */
  hangListClients = false;
```

  and as the first line of `listClients()`: `if (this.hangListClients) return new Promise(() => undefined);`

  In `apps/gateway/src/app.ts`: add to imports `import type { WorldHealth } from './client-id-resolver.js';` and `import type { BootstrapStatusView } from './status-file.js';`. `GatewayDeps` gains (after `relayIdentityChanged`):

```ts
  /** Turnkey: world-resolution state merged into /healthz (client-safe — no
   *  clientId). Absent, or returning null, omits the field. */
  worldStatus?: () => WorldHealth | null;
  /** Turnkey: whitelisted sidecar status.json view merged into /healthz;
   *  null (absent/unreadable) omits the field. */
  bootstrapStatus?: () => BootstrapStatusView | null;
  /** Bound for /healthz's relay probe (M18 pattern). Default 3000. */
  healthTimeoutMs?: number;
```

  In `buildApp`, next to the other defaults: `const healthTimeoutMs = deps.healthTimeoutMs ?? 3_000;` and replace the `/healthz` route with:

```ts
  app.get('/healthz', async (_req, reply) => {
    // Bounded probe: the relay is known to stall requests (docs/RELAY.md) —
    // the health surface must never hang with it.
    let relayState: 'connected' | 'disconnected' = 'connected';
    try {
      const ok = await Promise.race([
        relay.listClients().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), healthTimeoutMs)),
      ]);
      if (!ok) relayState = 'disconnected';
    } catch (err) {
      app.log.warn({ err }, 'relay health check failed');
      relayState = 'disconnected';
    }
    const world = deps.worldStatus?.() ?? null;
    const bootstrap = deps.bootstrapStatus?.() ?? null;
    return reply.code(200).send({
      ok: true,
      relay: relayState,
      ...(world !== null ? { world } : {}),
      ...(bootstrap !== null ? { bootstrap } : {}),
    });
  });
```

  In `apps/gateway/src/config.ts`: `GatewayConfig` gains `/** Turnkey: sidecar status.json merged into /healthz when set. */ statusFile?: string;` and loadConfig's return gains:

```ts
    ...(env.STATUS_FILE !== undefined && env.STATUS_FILE !== '' ? { statusFile: env.STATUS_FILE } : {}),
```

  In `apps/gateway/src/server.ts`, add the imports `import { readBootstrapStatus } from './status-file.js';` and pass into `buildApp` (next to `relayIdentityChanged`):

```ts
    worldStatus: () => resolver.healthView(),
    ...(cfg.statusFile !== undefined
      ? { bootstrapStatus: () => readBootstrapStatus(cfg.statusFile as string) }
      : {}),
```

  (`resolver.healthView()` returns null in explicit mode, so legacy deployments keep the legacy /healthz shape end-to-end.)

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/gateway test && pnpm --filter @companion/gateway typecheck`
Expected: PASS — including the untouched legacy healthz assertions in `app.test.ts` (`toEqual({ ok: true, relay: 'connected' })`).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/status-file.ts apps/gateway/src/app.ts apps/gateway/src/config.ts apps/gateway/src/server.ts apps/gateway/test/fakes.ts apps/gateway/test/healthz-status.test.ts
git commit -m "feat(gateway): /healthz world state + bootstrap status merge (bounded relay probe)"
```

---

### Task 6: Bootstrap sidecar package — provisioning core

**Files:**
- Create: `apps/bootstrap/package.json`, `apps/bootstrap/tsconfig.json`, `apps/bootstrap/src/scopes.ts`, `apps/bootstrap/src/relay-auth.ts`, `apps/bootstrap/src/key-file.ts`, `apps/bootstrap/src/status.ts`, `apps/bootstrap/src/provision.ts`
- Test: `apps/bootstrap/test/fake-relay-server.ts`, `apps/bootstrap/test/key-file.test.ts`, `apps/bootstrap/test/status.test.ts`, `apps/bootstrap/test/provision.test.ts`

**Interfaces:**
- Consumes: relay endpoint payloads captured in Task 0 findings §4 (`docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md`). **Named latitude:** the response-field extraction in `relay-auth.ts` (session-token field name, key field name, start-session body) is written below against the documented shapes (`docs/HOSTING.md:141-153`, `docs/LLM-SETUP-RUNBOOK.md:245-246`) — if the findings captured different names, fix the extraction lines AND the fake server to match the findings; nothing else changes.
- Produces (Task 7's main loop consumes):

```ts
// scopes.ts
export const GATEWAY_KEY_SCOPES: readonly string[]; // the ONE canonical list

// relay-auth.ts
export class RelayAuthError extends Error { status: number | undefined; endpoint: string }
export class RelayAuthClient {
  constructor(deps: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch });
  register(email: string, password: string): Promise<'created' | 'exists' | 'throttled'>;
  login(email: string, password: string): Promise<string>;                        // bearer
  mintKey(bearer: string, name: string, scopes: readonly string[]): Promise<string>;
  probeKey(key: string): Promise<'valid' | 'invalid' | 'unreachable'>;
  listClients(key: string): Promise<Array<{ clientId: string; worldId: string; isOnline: boolean }>>;
  sessionHandshake(key: string, foundryUrl: string, gmUser: string): Promise<{ status: number; body: Record<string, unknown> }>;
  startSession(key: string, handshakeBody: Record<string, unknown>, gmPassword: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

// key-file.ts
export function writeKeyFileAtomic(filePath: string, key: string): void; // 0600, same-dir tmp + rename
export function readPersistedKey(filePath: string): string | null;

// status.ts
export type BootstrapPhase =
  | 'starting' | 'waiting-relay' | 'provisioning-account' | 'minting-key' | 'key-ready'
  | 'placing-module' | 'waiting-world' | 'starting-session' | 'gm-login-failed'
  | 'needs-pairing' | 'online' | 'error';
export interface BootstrapStatus {
  phase: BootstrapPhase;
  detail: string;
  error: { class: string; message: string } | null;
  updatedAt: string;
}
export class StatusWriter {
  constructor(filePath: string);
  current(): BootstrapStatus;
  set(phase: BootstrapPhase, detail: string, error?: { class: string; message: string } | null): void; // atomic 0644 write
}

// provision.ts
export interface ProvisionDeps {
  relay: RelayAuthClient;
  email: string;
  password: string;
  keyFilePath: string;
  status: StatusWriter;
  log: { info(msg: string): void; warn(msg: string): void };
}
export function ensureKey(deps: ProvisionDeps): Promise<string>;
```

Package setup notes: `pnpm-workspace.yaml` already globs `apps/*` — creating the directory is enough, then run `pnpm install` once so the lockfile learns the package. The gateway deliberately ships no `@types/node`; this package is a DIFFERENT package and takes `@types/node` as a devDependency (pnpm's isolated linker keeps it out of the gateway's typecheck — Pitfall 16). The sidecar carries no secret in `status.json` by contract (0644, rendered on the LAN status page); `relay.env` is the only 0600 artifact.

- [ ] **Step 1: Package scaffolding.** `apps/bootstrap/package.json`:

```json
{
  "name": "@companion/bootstrap",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

  `apps/bootstrap/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

  Run `pnpm install` (updates `pnpm-lock.yaml`). `src/main.ts` does not exist until Task 7 — that is fine (`start` is unused until then; typecheck/test only see existing files).

- [ ] **Step 2: Write the failing tests.** `apps/bootstrap/test/fake-relay-server.ts` (test double, mirrors the relay 3.4.1 surface per Task 0 findings §4):

```ts
/**
 * In-process fake of the relay's auth/session surface, mirroring the shapes
 * captured in Task 0 findings §4. Tests drive provisioning + session logic
 * against real HTTP (node:http) exactly like the gateway's FakeRelay drives
 * routes — no network mocking.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeRelayClientRow {
  clientId: string;
  worldId: string;
  worldTitle: string;
  isOnline: boolean;
}

export class FakeRelayServer {
  readonly accounts = new Map<string, string>(); // email -> password
  readonly bearers = new Map<string, string>();  // bearer -> email
  readonly keys = new Map<string, string[]>();   // key -> scopes
  clients: FakeRelayClientRow[] = [];
  /** every /auth/* path hit, in order — lets tests assert "no auth calls". */
  readonly authCalls: string[] = [];
  readonly mintedScopes: string[][] = [];
  throttleAuth = false;
  gmPassword = 'gm-pass';
  /** set true to make /start-session mark the first client online. */
  sessionBringsOnline = true;

  private server: Server | null = null;
  private seq = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => (this.server as Server).listen(0, '127.0.0.1', resolve));
    const addr = (this.server as Server).address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const body = await readJson(req);
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith('/auth/')) {
      this.authCalls.push(url);
      if (this.throttleAuth) return send(429, { error: 'too many requests' });
    }
    if (req.method === 'POST' && url === '/auth/register') {
      const { email, password } = body as { email?: string; password?: string };
      if (typeof email !== 'string' || typeof password !== 'string') return send(400, { error: 'bad request' });
      if (this.accounts.has(email)) return send(409, { error: 'account exists' });
      this.accounts.set(email, password);
      return send(200, { sessionToken: this.newBearer(email) });
    }
    if (req.method === 'POST' && url === '/auth/login') {
      const { email, password } = body as { email?: string; password?: string };
      if (typeof email === 'string' && this.accounts.get(email) === password) {
        return send(200, { sessionToken: this.newBearer(email) });
      }
      return send(401, { error: 'invalid credentials' });
    }
    if (req.method === 'POST' && url === '/auth/api-keys') {
      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!this.bearers.has(bearer)) return send(401, { error: 'unauthorized' });
      const scopes = (body as { scopes?: string[] }).scopes ?? [];
      const key = `key-${++this.seq}`;
      this.keys.set(key, [...scopes]);
      this.mintedScopes.push([...scopes]);
      return send(200, { key });
    }
    if (req.method === 'GET' && url.startsWith('/clients')) {
      const key = (req.headers['x-api-key'] as string | undefined) ?? '';
      if (!this.keys.has(key)) return send(401, { error: 'unauthorized' });
      return send(200, { total: this.clients.length, clients: this.clients });
    }
    if (req.method === 'POST' && url === '/session-handshake') {
      const key = (req.headers['x-api-key'] as string | undefined) ?? '';
      if (!this.keys.has(key)) return send(401, { error: 'unauthorized' });
      return send(200, { token: 'hs-token-1' });
    }
    if (req.method === 'POST' && url === '/start-session') {
      const { token, password } = body as { token?: string; password?: string };
      if (token !== 'hs-token-1') return send(400, { error: 'bad handshake token' });
      if (password !== this.gmPassword) return send(401, { error: 'invalid credentials' });
      if (this.sessionBringsOnline && this.clients.length > 0) {
        (this.clients[0] as FakeRelayClientRow).isOnline = true;
      }
      return send(200, { sessionId: 'sess-1', clientId: this.clients[0]?.clientId ?? 'fvtt_new' });
    }
    return send(404, { error: 'not found' });
  }

  private newBearer(email: string): string {
    const bearer = `bearer-${++this.seq}`;
    this.bearers.set(bearer, email);
    return bearer;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += String(c)));
    req.on('end', () => {
      try {
        resolve(buf === '' ? {} : JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
  });
}
```

  `apps/bootstrap/test/key-file.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPersistedKey, writeKeyFileAtomic } from '../src/key-file.js';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'keyfile-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('key-file', () => {
  it('writes RELAY_API_KEY=<key> and reads it back', () => {
    const f = join(makeDir(), 'relay.env');
    writeKeyFileAtomic(f, 'abc-123');
    expect(readFileSync(f, 'utf8')).toBe('RELAY_API_KEY=abc-123\n');
    expect(readPersistedKey(f)).toBe('abc-123');
  });

  it('leaves no temp file behind (atomic rename)', () => {
    const dir = makeDir();
    const f = join(dir, 'relay.env');
    writeKeyFileAtomic(f, 'k1');
    writeKeyFileAtomic(f, 'k2');
    expect(readdirSync(dir)).toEqual(['relay.env']);
    expect(readPersistedKey(f)).toBe('k2');
  });

  it.skipIf(process.platform === 'win32')('sets mode 0600', () => {
    const f = join(makeDir(), 'relay.env');
    writeKeyFileAtomic(f, 'k');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('readPersistedKey: null on absent or unparseable', () => {
    expect(readPersistedKey(join(makeDir(), 'nope.env'))).toBeNull();
  });
});
```

  `apps/bootstrap/test/status.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusWriter } from '../src/status.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('StatusWriter', () => {
  it('writes whitelisted-shape JSON atomically and tracks current()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-'));
    dirs.push(dir);
    const f = join(dir, 'status.json');
    const w = new StatusWriter(f);
    expect(w.current().phase).toBe('starting');
    w.set('waiting-world', 'no world online yet');
    const onDisk = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
    expect(onDisk.phase).toBe('waiting-world');
    expect(onDisk.detail).toBe('no world online yet');
    expect(onDisk.error).toBeNull();
    expect(typeof onDisk.updatedAt).toBe('string');
    expect(readdirSync(dir)).toEqual(['status.json']); // no tmp leftover
    w.set('error', 'converge failed', { class: 'RelayAuthError', message: 'login failed' });
    expect(w.current().error).toEqual({ class: 'RelayAuthError', message: 'login failed' });
  });

  it('creates the parent directory if missing and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-'));
    dirs.push(dir);
    const w = new StatusWriter(join(dir, 'nested', 'status.json'));
    w.set('online', 'world online'); // must not throw
    expect(w.current().phase).toBe('online');
  });
});
```

  `apps/bootstrap/test/provision.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient, RelayAuthError } from '../src/relay-auth.js';
import { StatusWriter } from '../src/status.js';
import { ensureKey } from '../src/provision.js';
import { readPersistedKey, writeKeyFileAtomic } from '../src/key-file.js';
import { GATEWAY_KEY_SCOPES } from '../src/scopes.js';

const log = { info: () => undefined, warn: () => undefined };

describe('ensureKey', () => {
  let server: FakeRelayServer;
  let baseUrl: string;
  let dir: string;
  let keyFilePath: string;
  let status: StatusWriter;

  beforeEach(async () => {
    server = new FakeRelayServer();
    baseUrl = await server.start();
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    keyFilePath = join(dir, 'relay.env');
    status = new StatusWriter(join(dir, 'status.json'));
  });
  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    return {
      relay: new RelayAuthClient({ baseUrl, timeoutMs: 1000 }),
      email: 'ops@companion.local',
      password: 'acct-pass',
      keyFilePath,
      status,
      log,
    };
  }

  it('fresh relay DB: registers, logs in, mints with the EXACT canonical scopes, persists', async () => {
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(readPersistedKey(keyFilePath)).toBe('key-1');
    expect(server.mintedScopes[0]).toEqual([...GATEWAY_KEY_SCOPES]);
    expect(GATEWAY_KEY_SCOPES).toContain('encounter:read'); // the HOSTING.md:149 omission, fixed at the source
    expect(status.current().phase).toBe('key-ready');
  });

  it('valid persisted key: returns it with ZERO /auth calls (probe only)', async () => {
    await ensureKey(deps());
    const authCallsAfterFirst = server.authCalls.length;
    const again = await ensureKey(deps());
    expect(again).toBe('key-1');
    expect(server.authCalls.length).toBe(authCallsAfterFirst); // no /auth traffic at all
  });

  it('register conflict (account exists) falls through to login', async () => {
    server.accounts.set('ops@companion.local', 'acct-pass');
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(server.authCalls).toContain('/auth/register');
    expect(server.authCalls).toContain('/auth/login');
  });

  it('stale key vs fresh relay DB (401 probe): re-mints and overwrites the file', async () => {
    writeKeyFileAtomic(keyFilePath, 'key-from-wiped-db');
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(readPersistedKey(keyFilePath)).toBe('key-1');
  });

  it('auth throttle (429) raises RelayAuthError with status 429 (caller backs off)', async () => {
    server.throttleAuth = true;
    await expect(ensureKey(deps())).rejects.toMatchObject({ name: 'RelayAuthError', status: 429 });
  });

  it('relay unreachable: throws without touching the persisted file', async () => {
    writeKeyFileAtomic(keyFilePath, 'existing-key');
    await server.stop();
    await expect(ensureKey(deps())).rejects.toBeInstanceOf(RelayAuthError);
    expect(readPersistedKey(keyFilePath)).toBe('existing-key');
  });

  it('wrong account password after conflict: login fails with a named error', async () => {
    server.accounts.set('ops@companion.local', 'DIFFERENT-pass');
    await expect(ensureKey(deps())).rejects.toMatchObject({ name: 'RelayAuthError', endpoint: '/auth/login' });
  });
});
```

- [ ] **Step 3: Run tests, see them fail**

Run: `pnpm --filter @companion/bootstrap test`
Expected: FAIL — `Cannot find module '../src/relay-auth.js'` (and siblings).

- [ ] **Step 4: Implement.** `apps/bootstrap/src/scopes.ts`:

```ts
/**
 * THE canonical scope set for the gateway's relay API key — single-sourced
 * here (the spec's fix for docs/HOSTING.md:149 omitting encounter:read,
 * which silently breaks the M22 /api/encounter* routes). Composition:
 * docs/HOSTING.md A6 list + encounter:read (M22). wod5e needs no extra
 * scope (its adapter only emits POST /roll -> roll:execute).
 */
export const GATEWAY_KEY_SCOPES = [
  'entity:read',
  'entity:write',
  'search',
  'events:subscribe',
  'clients:read',
  'dnd5e',
  'roll:execute',
  'chat:read',
  'roll:read',
  'encounter:read',
] as const satisfies readonly string[];
```

  `apps/bootstrap/src/key-file.ts`:

```ts
/**
 * relay.env on the shared companion-runtime volume: the sidecar's handoff to
 * the gateway (RELAY_API_KEY_FILE). Written atomically — same-directory temp
 * file + rename (same fs is guaranteed by the volume; a cross-dir rename
 * could EXDEV) — so the gateway's watcher never sees a torn write. Mode 0600
 * (Global Constraints); writeFileSync's mode is masked by the process umask,
 * so chmod enforces it explicitly.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeKeyFileAtomic(filePath: string, key: string): void {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
  writeFileSync(tmp, `RELAY_API_KEY=${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows dev box: modes are advisory there; Linux is what matters */
  }
  renameSync(tmp, filePath);
}

/** The persisted key, or null when the file is absent/unparseable. */
export function readPersistedKey(filePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const m = /^RELAY_API_KEY=(.+)$/.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  return null;
}
```

  `apps/bootstrap/src/status.ts`:

```ts
/**
 * status.json on the shared volume: the sidecar's state machine surface,
 * merged into the gateway's /healthz and rendered by the status page. By
 * CONTRACT it carries no secret — phase/detail/error text only, never keys,
 * passwords, or the clientId (the gateway additionally whitelists on read).
 * 0644 (not secret); atomic same-dir tmp + rename; a failed write must never
 * kill the converge loop (status is best-effort).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type BootstrapPhase =
  | 'starting'
  | 'waiting-relay'
  | 'provisioning-account'
  | 'minting-key'
  | 'key-ready'
  | 'placing-module'
  | 'waiting-world'
  | 'starting-session'
  | 'gm-login-failed'
  | 'needs-pairing'
  | 'online'
  | 'error';

export interface BootstrapStatus {
  phase: BootstrapPhase;
  detail: string;
  error: { class: string; message: string } | null;
  updatedAt: string;
}

export class StatusWriter {
  private state: BootstrapStatus = {
    phase: 'starting',
    detail: 'sidecar starting',
    error: null,
    updatedAt: new Date().toISOString(),
  };

  constructor(private readonly filePath: string) {}

  current(): BootstrapStatus {
    return this.state;
  }

  set(phase: BootstrapPhase, detail: string, error: { class: string; message: string } | null = null): void {
    this.state = { phase, detail, error, updatedAt: new Date().toISOString() };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
      renameSync(tmp, this.filePath);
    } catch {
      // best-effort: never let a status write kill the converge loop
    }
  }
}
```

  `apps/bootstrap/src/relay-auth.ts`:

```ts
/**
 * The sidecar's own minimal relay HTTP client — auth + session surface only.
 * The gateway's foundry-client deliberately does not know these endpoints;
 * this file is the only place that does. Endpoint shapes: docs/HOSTING.md
 * A6/B4a + Task 0 findings §4 (live-captured on relay 3.4.1). If a captured
 * field name differs from the extraction below, fix it HERE (and in the fake
 * server) — callers only see the typed results. Every call is bounded.
 */
export class RelayAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RelayAuthError';
  }
}

export interface RelayAuthDeps {
  baseUrl: string;
  /** Bound for every call. Default 10000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

export class RelayAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly deps: RelayAuthDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  private async call(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<CallResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.deps.baseUrl).toString(), {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RelayAuthError(`relay unreachable: ${(err as Error).message}`, undefined, path);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body (throttle page etc.) — status carries the signal */
    }
    return { status: res.status, body };
  }

  /** POST /auth/register — 2xx = created; conflict/4xx = already registered
   *  (the idempotent path — login verifies authoritatively); 429 = throttled
   *  (~20 req/15 min/IP — the caller MUST back off, never hot-retry). */
  async register(email: string, password: string): Promise<'created' | 'exists' | 'throttled'> {
    const { status } = await this.call('POST', '/auth/register', { body: { email, password } });
    if (status === 429) return 'throttled';
    if (status >= 200 && status < 300) return 'created';
    return 'exists';
  }

  /** POST /auth/login {email,password} -> session bearer. */
  async login(email: string, password: string): Promise<string> {
    const { status, body } = await this.call('POST', '/auth/login', { body: { email, password } });
    if (status === 429) throw new RelayAuthError('auth throttled', 429, '/auth/login');
    // Field name per Task 0 findings §4 (docs: sessionToken; token = fallback).
    const token =
      typeof body.sessionToken === 'string' ? body.sessionToken : typeof body.token === 'string' ? body.token : null;
    if (status >= 200 && status < 300 && token !== null) return token;
    throw new RelayAuthError(`login failed (${status})`, status, '/auth/login');
  }

  /** POST /auth/api-keys {name, scopes} (Bearer) -> the key. Shown once. */
  async mintKey(bearer: string, name: string, scopes: readonly string[]): Promise<string> {
    const { status, body } = await this.call('POST', '/auth/api-keys', {
      headers: { authorization: `Bearer ${bearer}` },
      body: { name, scopes: [...scopes] },
    });
    if (status === 429) throw new RelayAuthError('auth throttled', 429, '/auth/api-keys');
    // Field name per Task 0 findings §4 (docs: key; apiKey = fallback).
    const key = typeof body.key === 'string' ? body.key : typeof body.apiKey === 'string' ? body.apiKey : null;
    if (status >= 200 && status < 300 && key !== null) return key;
    throw new RelayAuthError(`api-key mint failed (${status})`, status, '/auth/api-keys');
  }

  /** GET /clients as a cheap authenticated probe — NOT throttled like /auth. */
  async probeKey(key: string): Promise<'valid' | 'invalid' | 'unreachable'> {
    let result: CallResult;
    try {
      result = await this.call('GET', '/clients', { headers: { 'x-api-key': key } });
    } catch {
      return 'unreachable';
    }
    if (result.status === 200) return 'valid';
    if (result.status === 401 || result.status === 403) return 'invalid';
    return 'unreachable';
  }

  async listClients(key: string): Promise<Array<{ clientId: string; worldId: string; isOnline: boolean }>> {
    const { status, body } = await this.call('GET', '/clients', { headers: { 'x-api-key': key } });
    if (status !== 200) throw new RelayAuthError(`clients failed (${status})`, status, '/clients');
    const clients = body.clients;
    return Array.isArray(clients) ? (clients as Array<{ clientId: string; worldId: string; isOnline: boolean }>) : [];
  }

  /** POST /session-handshake — headers per docs/HOSTING.md:313 + findings §4. */
  async sessionHandshake(key: string, foundryUrl: string, gmUser: string): Promise<CallResult> {
    return this.call('POST', '/session-handshake', {
      headers: { 'x-api-key': key, 'x-foundry-url': foundryUrl, 'x-username': gmUser },
    });
  }

  /** POST /start-session — handshake body forwarded + the GM password
   *  (exact contract per Task 0 findings §4). */
  async startSession(key: string, handshakeBody: Record<string, unknown>, gmPassword: string): Promise<CallResult> {
    return this.call('POST', '/start-session', {
      headers: { 'x-api-key': key },
      body: { ...handshakeBody, password: gmPassword },
    });
  }
}
```

  `apps/bootstrap/src/provision.ts`:

```ts
/**
 * Key lifecycle (spec §Bootstrap sidecar 1): relay keys are shown once, so
 * "reuse" means persist + probe-validate + re-mint ONLY on 401/403. This
 * self-heals the wiped-independently case: fresh relay DB + stale key file
 * -> probe 401 -> re-mint; fresh key file + intact DB -> probe 200 -> zero
 * /auth traffic (the throttle budget is never touched on the steady path).
 */
import { GATEWAY_KEY_SCOPES } from './scopes.js';
import { readPersistedKey, writeKeyFileAtomic } from './key-file.js';
import { RelayAuthClient, RelayAuthError } from './relay-auth.js';
import type { StatusWriter } from './status.js';

export interface ProvisionDeps {
  relay: RelayAuthClient;
  email: string;
  password: string;
  keyFilePath: string;
  status: StatusWriter;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** One provisioning pass; throws on unreachable/throttled/login failure —
 *  the caller (main loop) retries with backoff on the next tick. */
export async function ensureKey(deps: ProvisionDeps): Promise<string> {
  const existing = readPersistedKey(deps.keyFilePath);
  if (existing !== null) {
    const verdict = await deps.relay.probeKey(existing);
    if (verdict === 'valid') return existing;
    if (verdict === 'unreachable') {
      throw new RelayAuthError('relay unreachable during key probe', undefined, '/clients');
    }
    deps.log.warn('persisted relay key rejected (stale key vs fresh relay DB?); re-minting');
  }
  deps.status.set('provisioning-account', 'registering the relay account');
  const reg = await deps.relay.register(deps.email, deps.password);
  if (reg === 'throttled') throw new RelayAuthError('auth throttled', 429, '/auth/register');
  const bearer = await deps.relay.login(deps.email, deps.password);
  deps.status.set('minting-key', 'minting the gateway API key');
  const key = await deps.relay.mintKey(bearer, 'companion-gateway', GATEWAY_KEY_SCOPES);
  writeKeyFileAtomic(deps.keyFilePath, key);
  const verdict = await deps.relay.probeKey(key);
  if (verdict !== 'valid') {
    throw new RelayAuthError(`freshly minted key failed its probe (${verdict})`, undefined, '/clients');
  }
  deps.status.set('key-ready', 'relay credentials ready');
  deps.log.info('gateway relay key minted and persisted');
  return key;
}
```

- [ ] **Step 5: Run tests, see them pass**

Run: `pnpm --filter @companion/bootstrap test && pnpm --filter @companion/bootstrap typecheck`
Expected: PASS (all key-file/status/provision cases). Then the workspace gate: `pnpm typecheck && pnpm test` → green everywhere.

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml apps/bootstrap
git commit -m "feat(bootstrap): relay provisioning core (register/login/mint/probe, atomic relay.env)"
```

---

### Task 7: Bootstrap sidecar — session keeper, module pre-place, status page, converge loop, image

**Files:**
- Create: `apps/bootstrap/src/session.ts`, `apps/bootstrap/src/module-install.ts`, `apps/bootstrap/src/foundry-admin.ts`, `apps/bootstrap/src/status-page.ts`, `apps/bootstrap/src/main.ts`, `apps/bootstrap/Dockerfile`, `apps/bootstrap/docker-entrypoint.sh`
- Test: `apps/bootstrap/test/session.test.ts`, `apps/bootstrap/test/module-install.test.ts`, `apps/bootstrap/test/status-page.test.ts`

**Interfaces:**
- Consumes: `RelayAuthClient`, `StatusWriter`, `BootstrapPhase`, `ensureKey`, `readPersistedKey` (Task 6); Task 0 findings §1 (headless verdict), §2 (admin relaunch recipe + `/api/status` shape), §5 (wsRelayUrl guidance text).
- Produces:

```ts
// session.ts
export const HEADLESS_SELF_PAIR: boolean; // set from Task 0 findings §1 verdict
export type SessionOutcome = 'online' | 'needs-pairing' | 'gm-login-failed' | 'relay-unreachable' | 'session-failed';
export function worldOnline(relay: RelayAuthClient, key: string): Promise<'online' | 'offline' | 'unreachable'>;
export interface SessionDeps {
  relay: RelayAuthClient; key: string; foundryUrl: string;
  gmUser: string; gmPassword: string;
  log: { info(msg: string): void; warn(msg: string): void };
}
export function attemptSession(deps: SessionDeps): Promise<SessionOutcome>;

// module-install.ts
export type ModulePlacement = 'placed' | 'already-present' | 'foundry-not-ready';
export function ensureModulePlaced(srcDir: string, foundryDataDir: string): ModulePlacement;

// foundry-admin.ts
export const ADMIN_RELAUNCH: boolean; // set from Task 0 findings §2 verdict (b2)
export type RelaunchOutcome = 'launched' | 'already-active' | 'no-world' | 'multiple-worlds' | 'skipped' | 'failed';
export interface RelaunchDeps {
  foundryUrl: string; adminKey: string; foundryDataDir: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
  log: { info(msg: string): void; warn(msg: string): void };
}
export function relaunchWorldIfIdle(deps: RelaunchDeps): Promise<RelaunchOutcome>;

// status-page.ts
export function renderStatusHtml(s: BootstrapStatus): string;   // escaped, no secrets
export function startStatusPage(port: number, current: () => BootstrapStatus): import('node:http').Server;
```

**Task 0 verdict switches (both are single consts, set once from the findings):** `HEADLESS_SELF_PAIR` (findings §1) — `true` = a virgin world (zero client rows) is brought online via handshake+start-session; `false` = zero client rows returns `needs-pairing` immediately (the one-time guided browser pairing; handshake still runs for a once-paired-but-offline client row). `ADMIN_RELAUNCH` (findings §2 b2) — `false` makes `relaunchWorldIfIdle` return `'skipped'` unconditionally. **Named latitude:** the HTTP recipe inside `relaunchWorldIfIdle` (routes/bodies/cookie handling) is written below against the expected `/auth` + `/setup` shape — replace it with the exact recipe captured in findings §2 if it differs.

- [ ] **Step 1: Write the failing tests.** `apps/bootstrap/test/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient } from '../src/relay-auth.js';
import { attemptSession, HEADLESS_SELF_PAIR, worldOnline, type SessionDeps } from '../src/session.js';

const log = { info: () => undefined, warn: () => undefined };

describe('session keeper', () => {
  let server: FakeRelayServer;
  let relay: RelayAuthClient;
  let key: string;

  beforeEach(async () => {
    server = new FakeRelayServer();
    const baseUrl = await server.start();
    relay = new RelayAuthClient({ baseUrl, timeoutMs: 1000 });
    server.keys.set('k-test', ['clients:read']);
    key = 'k-test';
  });
  afterEach(async () => {
    await server.stop();
  });

  function deps(): SessionDeps {
    return { relay, key, foundryUrl: 'http://foundry:30000', gmUser: 'Gamemaster', gmPassword: 'gm-pass', log };
  }

  it('worldOnline: online / offline / unreachable', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: true }];
    expect(await worldOnline(relay, key)).toBe('online');
    (server.clients[0] as { isOnline: boolean }).isOnline = false;
    expect(await worldOnline(relay, key)).toBe('offline');
    await server.stop();
    expect(await worldOnline(relay, key)).toBe('unreachable');
  });

  it('offline client row + correct GM creds: handshake + start-session -> online', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: false }];
    expect(await attemptSession(deps())).toBe('online');
    expect((server.clients[0] as { isOnline: boolean }).isOnline).toBe(true);
  });

  it('wrong GM password -> gm-login-failed', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: false }];
    server.gmPassword = 'the-real-one';
    expect(await attemptSession(deps())).toBe('gm-login-failed');
  });

  it('zero client rows follows the Task 0(a) verdict switch', async () => {
    server.clients = [];
    server.sessionBringsOnline = false;
    const outcome = await attemptSession(deps());
    if (HEADLESS_SELF_PAIR) {
      // self-pair attempt ran; with no client to bring online it reports session-failed
      expect(outcome).toBe('session-failed');
    } else {
      expect(outcome).toBe('needs-pairing');
    }
  });

  it('relay down -> relay-unreachable', async () => {
    await server.stop();
    expect(await attemptSession(deps())).toBe('relay-unreachable');
  });
});
```

  `apps/bootstrap/test/module-install.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureModulePlaced } from '../src/module-install.js';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'modinst-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeSrc(): string {
  const src = join(makeDir(), 'foundry-rest-api');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  writeFileSync(join(src, 'module.json'), '{"id":"foundry-rest-api","version":"3.4.1"}', 'utf8');
  writeFileSync(join(src, 'scripts', 'module.js'), '// module', 'utf8');
  return src;
}

describe('ensureModulePlaced', () => {
  it('waits for felddy to initialize Data/', () => {
    const dataRoot = makeDir(); // no Data/ inside
    expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('foundry-not-ready');
  });

  it('copies the module once and is idempotent', () => {
    const dataRoot = makeDir();
    mkdirSync(join(dataRoot, 'Data'), { recursive: true });
    const src = makeSrc();
    expect(ensureModulePlaced(src, dataRoot)).toBe('placed');
    expect(existsSync(join(dataRoot, 'Data', 'modules', 'foundry-rest-api', 'module.json'))).toBe(true);
    expect(existsSync(join(dataRoot, 'Data', 'modules', 'foundry-rest-api', 'scripts', 'module.js'))).toBe(true);
    expect(ensureModulePlaced(src, dataRoot)).toBe('already-present');
  });

  it('never overwrites an existing install (operator may have updated it)', () => {
    const dataRoot = makeDir();
    const dest = join(dataRoot, 'Data', 'modules', 'foundry-rest-api');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'module.json'), '{"id":"foundry-rest-api","version":"9.9.9"}', 'utf8');
    expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('already-present');
    expect(readFileSync(join(dest, 'module.json'), 'utf8')).toContain('9.9.9');
  });
});
```

  `apps/bootstrap/test/status-page.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderStatusHtml } from '../src/status-page.js';
import type { BootstrapStatus } from '../src/status.js';

function status(phase: BootstrapStatus['phase'], detail = 'd'): BootstrapStatus {
  return { phase, detail, error: null, updatedAt: '2026-07-15T12:00:00Z' };
}

describe('renderStatusHtml', () => {
  it('renders phase, guidance, and detail', () => {
    const html = renderStatusHtml(status('waiting-world'));
    expect(html).toContain('waiting-world');
    expect(html).toContain('create your world'); // guidance text
  });

  it('escapes detail/error content (no HTML injection from the volume)', () => {
    const html = renderStatusHtml({
      phase: 'error',
      detail: '<script>alert(1)</script>',
      error: { class: 'X<Y', message: 'a&b' },
      updatedAt: 'x',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('needs-pairing renders the guided one-time pairing instructions', () => {
    const html = renderStatusHtml(status('needs-pairing'));
    expect(html).toContain('Pair');
    expect(html).toContain('/pair/');
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/bootstrap test`
Expected: FAIL — `Cannot find module '../src/session.js'` (and siblings).

- [ ] **Step 3: Implement the modules.** `apps/bootstrap/src/session.ts`:

```ts
/**
 * Keep-the-world-online pass (spec §Bootstrap sidecar 3). The REST module
 * only runs inside a logged-in GM browser; the relay ships a headless Chrome
 * that logs in itself via POST /session-handshake + /start-session
 * (docs/RELAY.md, docs/HOSTING.md B4a; payloads Task 0 findings §4).
 *
 * HEADLESS_SELF_PAIR is the Task 0(a) verdict (findings §1): whether a
 * NEVER-paired ("virgin") world can be brought online headlessly. When
 * false, zero client rows -> 'needs-pairing' (the status page guides the
 * accepted one-time browser pairing); the handshake still runs for a
 * once-paired-but-offline client row.
 */
import type { RelayAuthClient } from './relay-auth.js';

export const HEADLESS_SELF_PAIR = true; // <- SET FROM Task 0 findings §1 VERDICT

export type SessionOutcome = 'online' | 'needs-pairing' | 'gm-login-failed' | 'relay-unreachable' | 'session-failed';

export async function worldOnline(relay: RelayAuthClient, key: string): Promise<'online' | 'offline' | 'unreachable'> {
  try {
    const clients = await relay.listClients(key);
    return clients.some((c) => c.isOnline === true) ? 'online' : 'offline';
  } catch {
    return 'unreachable';
  }
}

export interface SessionDeps {
  relay: RelayAuthClient;
  key: string;
  /** Reachable FROM THE RELAY CONTAINER, e.g. http://foundry:30000. */
  foundryUrl: string;
  gmUser: string;
  gmPassword: string;
  log: { info(msg: string): void; warn(msg: string): void };
}

export async function attemptSession(deps: SessionDeps): Promise<SessionOutcome> {
  let clients: Array<{ isOnline: boolean }>;
  try {
    clients = await deps.relay.listClients(deps.key);
  } catch {
    return 'relay-unreachable';
  }
  if (clients.some((c) => c.isOnline === true)) return 'online';
  if (clients.length === 0 && !HEADLESS_SELF_PAIR) return 'needs-pairing';

  let hs: { status: number; body: Record<string, unknown> };
  try {
    hs = await deps.relay.sessionHandshake(deps.key, deps.foundryUrl, deps.gmUser);
  } catch {
    return 'relay-unreachable';
  }
  if (hs.status < 200 || hs.status >= 300) {
    deps.log.warn(`session-handshake failed (${hs.status}) — Foundry warming or at the setup screen?`);
    return 'session-failed';
  }
  let started: { status: number; body: Record<string, unknown> };
  try {
    started = await deps.relay.startSession(deps.key, hs.body, deps.gmPassword);
  } catch {
    return 'relay-unreachable';
  }
  if (started.status >= 200 && started.status < 300) {
    // Trust /clients, not the response: confirm the world actually flipped.
    return (await worldOnline(deps.relay, deps.key)) === 'online' ? 'online' : 'session-failed';
  }
  const msg = typeof started.body.error === 'string' ? started.body.error : '';
  if (started.status === 401 || /credential|password|login/i.test(msg)) return 'gm-login-failed';
  deps.log.warn(`start-session failed (${started.status})`);
  return 'session-failed';
}
```

  `apps/bootstrap/src/module-install.ts`:

```ts
/**
 * Pre-place the pinned foundry-rest-api module (spec §Bootstrap sidecar 2).
 * The payload is baked into the image at /opt/foundry-rest-api (Dockerfile,
 * release 3.4.1 per VERSIONS.md). Copy-only and never-overwrite: per-world
 * ENABLE stays a documented one-tick operator step, and an operator-updated
 * module dir is respected — we never write into the world settings DB.
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ModulePlacement = 'placed' | 'already-present' | 'foundry-not-ready';

export function ensureModulePlaced(srcDir: string, foundryDataDir: string): ModulePlacement {
  const dataDir = join(foundryDataDir, 'Data');
  if (!existsSync(dataDir)) return 'foundry-not-ready'; // felddy has not initialized /data yet
  const dest = join(dataDir, 'modules', 'foundry-rest-api');
  if (existsSync(join(dest, 'module.json'))) return 'already-present';
  cpSync(srcDir, dest, { recursive: true });
  return 'placed';
}
```

  `apps/bootstrap/src/foundry-admin.ts`:

```ts
/**
 * World relaunch after a reboot (spec §Bootstrap sidecar 4): felddy only
 * auto-launches when FOUNDRY_WORLD is preset, which a bring-your-own-world
 * stack cannot do. When Foundry is at the setup screen but exactly one world
 * exists on disk, drive Foundry's own admin surface to launch it.
 *
 * ADMIN_RELAUNCH is the Task 0(b) verdict (findings §2). The HTTP recipe
 * below (POST /auth adminAuth -> POST /setup launchWorld, cookie-carried) is
 * the expected shape — REPLACE it with the exact captured recipe from the
 * findings if it differs. GET /api/status is Foundry's own idle/active probe
 * (shape captured in findings §2).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ADMIN_RELAUNCH = true; // <- SET FROM Task 0 findings §2 (b2) VERDICT

export type RelaunchOutcome = 'launched' | 'already-active' | 'no-world' | 'multiple-worlds' | 'skipped' | 'failed';

export interface RelaunchDeps {
  foundryUrl: string;
  adminKey: string;
  foundryDataDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log: { info(msg: string): void; warn(msg: string): void };
}

export async function relaunchWorldIfIdle(deps: RelaunchDeps): Promise<RelaunchOutcome> {
  if (!ADMIN_RELAUNCH) return 'skipped';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  try {
    const statusRes = await fetchImpl(new URL('/api/status', deps.foundryUrl).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = (await statusRes.json()) as Record<string, unknown>;
    // Findings §2: an idle server reports no active world on /api/status.
    if (status.world !== undefined && status.world !== null && status.active !== false) return 'already-active';
  } catch {
    return 'failed'; // Foundry not up yet — the loop retries later
  }
  const worldsDir = join(deps.foundryDataDir, 'Data', 'worlds');
  if (!existsSync(worldsDir)) return 'no-world';
  const worlds = readdirSync(worldsDir).filter((d) => existsSync(join(worldsDir, d, 'world.json')));
  if (worlds.length === 0) return 'no-world';
  if (worlds.length > 1) return 'multiple-worlds'; // v1: never guess — status page says launch manually
  const worldId = worlds[0] as string;
  try {
    const authRes = await fetchImpl(new URL('/auth', deps.foundryUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'adminAuth', adminPassword: deps.adminKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cookie = authRes.headers.get('set-cookie') ?? '';
    const launchRes = await fetchImpl(new URL('/setup', deps.foundryUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie !== '' ? { cookie } : {}) },
      body: JSON.stringify({ action: 'launchWorld', world: worldId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (launchRes.status >= 200 && launchRes.status < 300) {
      deps.log.info(`relaunched world ${worldId}`);
      return 'launched';
    }
    deps.log.warn(`world relaunch rejected (${launchRes.status})`);
    return 'failed';
  } catch (err) {
    deps.log.warn(`world relaunch failed: ${(err as Error).message}`);
    return 'failed';
  }
}
```

  `apps/bootstrap/src/status-page.ts`:

```ts
/**
 * Read-only first-run status page (spec Phase 1): one LAN-bound HTML page
 * that answers "where is my stack" — relay up -> key minted -> module placed
 * -> waiting for world -> gm login failed -> pair once (fallback) -> online.
 * Read-only by design: no secret entry (that is the out-of-scope Phase 2),
 * and stored secrets are NEVER rendered (status.json carries none by
 * contract, and everything is HTML-escaped anyway).
 */
import { createServer, type Server } from 'node:http';
import type { BootstrapPhase, BootstrapStatus } from './status.js';

const GUIDANCE: Record<BootstrapPhase, string> = {
  starting: 'Sidecar starting…',
  'waiting-relay': 'Waiting for the relay to come up. This resolves by itself.',
  'provisioning-account': 'Registering the relay account…',
  'minting-key': 'Minting the gateway API key…',
  'key-ready': 'Relay credentials ready.',
  'placing-module': 'Installing the REST API module into Foundry…',
  'waiting-world':
    'Open Foundry (port 30000), then: create your world, set the Gamemaster password to the one `make setup` printed, enable the "Foundry REST API" module in that world, set its WebSocket Relay URL as printed by setup, and launch the world.',
  'starting-session': 'Bringing the world online…',
  'gm-login-failed':
    'The headless GM login was rejected. In the world, make sure the Gamemaster password matches FOUNDRY_GM_PASSWORD in stack/quickstart/secrets/bootstrap.env.',
  'needs-pairing':
    'One-time pairing needed: open the world as GM, open the REST API Connection dialog, click Pair, then open http://<this-host>:3010/pair/<CODE> and approve with the relay account from the setup output.',
  online: 'World online. Invite players from the admin console.',
  error: 'The sidecar hit an error and will retry automatically. See detail below.',
};

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderStatusHtml(s: BootstrapStatus): string {
  const err =
    s.error === null
      ? ''
      : `<p class="err"><strong>${escapeHtml(s.error.class)}</strong>: ${escapeHtml(s.error.message)}</p>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Foundry's Unseen Servant — setup status</title>
<style>body{font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}
.phase{font-size:1.4rem;font-weight:700}.err{color:#a00}</style></head>
<body>
<h1>Setup status</h1>
<p class="phase">${escapeHtml(s.phase)}</p>
<p>${escapeHtml(GUIDANCE[s.phase])}</p>
<p><em>${escapeHtml(s.detail)}</em></p>
${err}
<p><small>updated ${escapeHtml(s.updatedAt)} — this page refreshes itself</small></p>
</body></html>`;
}

export function startStatusPage(port: number, current: () => BootstrapStatus): Server {
  const server = createServer((req, res) => {
    const s = current();
    if (req.url === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderStatusHtml(s));
  });
  server.listen(port, '0.0.0.0');
  return server;
}
```

  (Note: `GUIDANCE['waiting-world']` must contain the phrase `create your world` and `GUIDANCE['needs-pairing']` the substring `/pair/` — the tests key on them; keep them if rewording.)

  `apps/bootstrap/src/main.ts`:

```ts
/**
 * The converge loop (spec §Bootstrap sidecar): an always-on state machine
 * that never exits — every pass is idempotent, every failure is retried
 * with backoff, restart: unless-stopped re-converges after crashes.
 * Ordering per pass: key -> module placement -> world relaunch -> session.
 * /auth traffic is gated by AUTH_BACKOFF_MS (relay throttle, Pitfall 1);
 * session attempts by SESSION_BACKOFF_MS (each spawns a headless-Chrome
 * login, Pitfall 13). Secrets are never logged.
 */
import { join } from 'node:path';
import { RelayAuthClient, RelayAuthError } from './relay-auth.js';
import { StatusWriter } from './status.js';
import { ensureKey } from './provision.js';
import { attemptSession, worldOnline } from './session.js';
import { ensureModulePlaced } from './module-install.js';
import { relaunchWorldIfIdle } from './foundry-admin.js';
import { startStatusPage } from './status-page.js';
import { readPersistedKey } from './key-file.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing required env var ${name}`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env var ${name} must be a positive integer`);
  return n;
}

const log = {
  info: (msg: string): void => console.log(JSON.stringify({ level: 'info', msg })),
  warn: (msg: string): void => console.log(JSON.stringify({ level: 'warn', msg })),
};

async function main(): Promise<void> {
  const relayUrl = requiredEnv('RELAY_URL');
  const email = requiredEnv('RELAY_ACCOUNT_EMAIL');
  const password = requiredEnv('RELAY_ACCOUNT_PASSWORD');
  const foundryUrl = requiredEnv('FOUNDRY_URL');
  const gmUser = requiredEnv('FOUNDRY_GM_USER');
  const gmPassword = requiredEnv('FOUNDRY_GM_PASSWORD');
  const adminKey = requiredEnv('FOUNDRY_ADMIN_KEY');
  const runtimeDir = process.env.RUNTIME_DIR ?? '/run/companion';
  const foundryDataDir = process.env.FOUNDRY_DATA_DIR ?? '/foundry-data';
  const moduleSrcDir = process.env.MODULE_SRC_DIR ?? '/opt/foundry-rest-api';
  const statusPort = intEnv('STATUS_PORT', 8321);
  const pollMs = intEnv('POLL_MS', 10_000);
  const authBackoffMs = intEnv('AUTH_BACKOFF_MS', 60_000);
  const sessionBackoffMs = intEnv('SESSION_BACKOFF_MS', 60_000);

  const keyFilePath = join(runtimeDir, 'relay.env');
  const status = new StatusWriter(join(runtimeDir, 'status.json'));
  const relay = new RelayAuthClient({ baseUrl: relayUrl });
  startStatusPage(statusPort, () => status.current());
  log.info(`bootstrap sidecar up; status page on :${statusPort}`);

  let lastAuthAttemptAt = 0;
  let lastSessionAttemptAt = 0;

  for (;;) {
    try {
      // 1. Key: steady path is probe-only (no /auth traffic, no throttle).
      let key = readPersistedKey(keyFilePath);
      const probed = key !== null ? await relay.probeKey(key) : 'invalid';
      if (probed !== 'valid') {
        if (probed === 'unreachable') {
          status.set('waiting-relay', 'relay not reachable yet');
          key = null;
        } else if (Date.now() - lastAuthAttemptAt < authBackoffMs) {
          status.set('waiting-relay', 'backing off before the next auth attempt (relay /auth throttle)');
          key = null;
        } else {
          lastAuthAttemptAt = Date.now();
          key = await ensureKey({ relay, email, password, keyFilePath, status, log });
        }
      }

      if (key !== null) {
        // 2. Module pre-placement (idempotent; waits for felddy's /data init).
        const placement = ensureModulePlaced(moduleSrcDir, foundryDataDir);
        if (placement === 'placed') {
          status.set('placing-module', 'foundry-rest-api module installed');
          log.info('foundry-rest-api module placed into the Foundry data volume');
        }

        // 3. World relaunch after reboot (Task 0(b)-gated; best-effort).
        await relaunchWorldIfIdle({ foundryUrl, adminKey, foundryDataDir, log });

        // 4. Session convergence (bounded attempt rate — Pitfall 13).
        const online = await worldOnline(relay, key);
        if (online === 'online') {
          status.set('online', 'world online');
        } else if (online === 'unreachable') {
          status.set('waiting-relay', 'relay unreachable');
        } else if (Date.now() - lastSessionAttemptAt >= sessionBackoffMs) {
          lastSessionAttemptAt = Date.now();
          status.set('starting-session', 'attempting a headless GM session');
          const outcome = await attemptSession({ relay, key, foundryUrl, gmUser, gmPassword, log });
          switch (outcome) {
            case 'online':
              status.set('online', 'world online');
              break;
            case 'needs-pairing':
              status.set('needs-pairing', 'one-time browser pairing required');
              break;
            case 'gm-login-failed':
              status.set('gm-login-failed', 'headless GM login rejected');
              break;
            case 'relay-unreachable':
              status.set('waiting-relay', 'relay unreachable');
              break;
            case 'session-failed':
              status.set('waiting-world', 'no world online yet — create/launch your world in Foundry');
              break;
          }
        }
        // between session attempts: keep the last sticky status untouched
      }
    } catch (err) {
      const e = err as Error;
      const cls = e instanceof RelayAuthError ? e.name : (e.name ?? 'Error');
      status.set('error', 'converge pass failed; retrying', { class: cls, message: e.message });
      log.warn(`converge pass failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error('bootstrap failed to start:', (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/bootstrap test && pnpm --filter @companion/bootstrap typecheck`
Expected: PASS.

- [ ] **Step 5: Image.** `apps/bootstrap/docker-entrypoint.sh`:

```sh
#!/bin/sh
set -e
# First-mount ownership (Pitfall 2): the named volume may be root-owned no
# matter what the image declares — copy-up only applies to the first mounting
# container. Fix as root, then drop to the pinned non-root UID (Global
# Constraints). Under rootless podman "root" is the unprivileged host user,
# so this is safe there too (Task 0(c)-verified).
mkdir -p "${RUNTIME_DIR:-/run/companion}"
chown -R companion:companion "${RUNTIME_DIR:-/run/companion}"
exec su-exec companion:companion "$@"
```

  `apps/bootstrap/Dockerfile` (mirrors `apps/gateway/Dockerfile`; build context = repo root):

```dockerfile
# Build context = repo root (workspace install needs the root lockfile).
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/bootstrap/package.json apps/bootstrap/
RUN pnpm install --frozen-lockfile --filter @companion/bootstrap... --prod

FROM node:22-alpine AS module
# Pinned REST module payload (VERSIONS.md: foundry-rest-api 3.4.1) baked at
# build time so the sidecar can pre-place it without network access.
ADD https://github.com/ThreeHats/foundryvtt-rest-api/releases/download/3.4.1/module.zip /tmp/module.zip
RUN apk add --no-cache unzip && mkdir -p /opt/foundry-rest-api && unzip -q /tmp/module.zip -d /opt/foundry-rest-api

FROM node:22-alpine
WORKDIR /repo
RUN corepack enable && apk add --no-cache wget su-exec && adduser -D -u 3000 companion
COPY --from=module /opt/foundry-rest-api /opt/foundry-rest-api
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/bootstrap/node_modules ./apps/bootstrap/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/bootstrap ./apps/bootstrap
COPY apps/bootstrap/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV RUNTIME_DIR=/run/companion STATUS_PORT=8321
EXPOSE 8321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8321/status.json || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /repo/apps/bootstrap
CMD ["npx", "tsx", "src/main.ts"]
```

  Build smoke test — run from the repo root:

Run: `docker build -f apps/bootstrap/Dockerfile -t companion-bootstrap:dev .`
Expected: image builds; `docker run --rm companion-bootstrap:dev sh -c "ls /opt/foundry-rest-api/module.json && id companion"` prints the module.json path and `uid=3000`.

- [ ] **Step 6: Full gates + commit**

Run: `pnpm typecheck && pnpm test`
Expected: green across the workspace.

```bash
git add apps/bootstrap
git commit -m "feat(bootstrap): session keeper, module pre-place, status page, converge loop, image"
```

---

### Task 8: Quickstart compose — self-wiring, socket-free, TLS profile

**Files:**
- Create: `stack/quickstart/docker-compose.yml`, `stack/quickstart/Caddyfile`, `stack/quickstart/Caddyfile.tls.example`, `stack/quickstart/.env.example`, `stack/quickstart/secrets/foundry-config.json.example`, `stack/quickstart/secrets/bootstrap.env.example`, `stack/quickstart/secrets/gateway.env.example`
- Modify: `.gitignore` (append quickstart generated files)

**Interfaces:**
- Consumes: the bootstrap image (Task 7), gateway env contract (`RELAY_API_KEY_FILE`, `RELAY_CLIENT_ID=auto`, `STATUS_FILE` — Tasks 1/3/5), Task 0 findings §2 (config.json keys, `FOUNDRY_PROXY_PORT` empty behavior) and §3 (`format: raw` provider verdict).
- Produces: the compose project every later task runs (`stack/quickstart/` is its own compose project dir — its `.env` never collides with `stack/.env`, and named volumes are prefixed by the project name).

Design rules encoded here: named volumes only (no bind-mounted data dirs — rootless-podman UID pain); secrets enter via mounted files (`config.json`) or `env_file: format: raw`; NON-secret knobs (ports, domains, profile toggle) come from `stack/quickstart/.env` via standard compose `${…}` interpolation — that is allowed, interpolation is only banned for SECRET values; `hostname: foundry` pinned; every service `restart: unless-stopped`; no `depends_on` chains that imply restart-coupling (services converge, Global Constraints); no socket mounts anywhere.

- [ ] **Step 1: Write the compose file** — `stack/quickstart/docker-compose.yml`:

```yaml
name: unseen-servant-quickstart

# Turnkey stack (docs/HOSTING.md Part C). One command after `make setup`:
#   docker compose up -d --build     (or: podman compose up -d --build)
# Self-wiring: the bootstrap sidecar mints the relay key at runtime and hands
# it to the gateway over the shared companion-runtime volume; the gateway
# resolves the world clientId automatically (RELAY_CLIENT_ID=auto). No
# container-runtime socket anywhere; docker + rootless podman parity.
# Secrets: stack/quickstart/secrets/* (written by `make setup`, mode 0600) —
# mounted files or env_file format:raw, never compose-interpolated.

services:
  foundry:
    image: felddy/foundryvtt:13.351.0
    # License signature binds to the hostname — never change (HOSTING.md A2).
    hostname: foundry
    environment:
      - FOUNDRY_MINIFY_STATIC_FILES=true
      # TLS profile knobs (non-secret, from .env; empty = direct HTTP —
      # Task 0 findings §2 verified empty FOUNDRY_PROXY_PORT is treated as unset):
      - FOUNDRY_PROXY_SSL=${FOUNDRY_PROXY_SSL:-false}
      - FOUNDRY_PROXY_PORT=${FOUNDRY_PROXY_PORT:-}
    volumes:
      - foundry-data:/data
      # felddy credentials file (Task 0 findings §2): license creds + admin
      # key live here, NOT in process env.
      - ./secrets/foundry-config.json:/run/secrets/config.json:ro
    ports:
      - "${HOST_PORT_FOUNDRY:-30000}:30000"
    restart: unless-stopped

  relay:
    image: threehats/foundryvtt-rest-api-relay:3.4.1
    environment:
      - APP_ENV=production
      - PORT=3010
      - DB_TYPE=sqlite
    volumes:
      - relay-data:/app/data
    ports:
      # Published so the operator's GM browser (module WS) can reach it —
      # wsRelayUrl guidance per Task 0 findings §5.
      - "${HOST_PORT_RELAY:-3010}:3010"
    restart: unless-stopped

  bootstrap:
    build:
      context: ../..
      dockerfile: apps/bootstrap/Dockerfile
    env_file:
      # raw: secret values must survive verbatim (no $-interpolation)
      - path: ./secrets/bootstrap.env
        format: raw
    environment:
      - RELAY_URL=http://relay:3010
      - FOUNDRY_URL=http://foundry:30000
      - RUNTIME_DIR=/run/companion
      - FOUNDRY_DATA_DIR=/foundry-data
      - STATUS_PORT=8321
    volumes:
      - companion-runtime:/run/companion
      - foundry-data:/foundry-data
    ports:
      - "${HOST_PORT_STATUS:-8321}:8321"
    restart: unless-stopped

  gateway:
    build:
      context: ../..
      dockerfile: apps/gateway/Dockerfile
    env_file:
      - path: ./secrets/gateway.env
        format: raw
    environment:
      - PORT=8090
      - RELAY_URL=http://relay:3010
      - RELAY_API_KEY_FILE=/run/companion/relay.env
      - RELAY_CLIENT_ID=auto
      - STATUS_FILE=/run/companion/status.json
      - PLAYERS_FILE=/data/players.yaml
    volumes:
      - gateway-data:/data
      - companion-runtime:/run/companion:ro
    expose:
      - "8090"
    restart: unless-stopped

  web:
    build:
      context: ../..
      dockerfile: apps/web/Dockerfile
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    ports:
      # 8080 by default: rootless podman cannot bind <1024 (Pitfall 5).
      - "${HOST_PORT_WEB:-8080}:80"
    restart: unless-stopped

  # Opt-in TLS on the operator's domain: `make setup` writes Caddyfile.tls and
  # sets COMPOSE_PROFILES=tls in .env. Binding 80/443 rootless needs
  # `sysctl net.ipv4.ip_unprivileged_port_start=80` (docs Part C).
  web-tls:
    profiles: ["tls"]
    build:
      context: ../..
      dockerfile: apps/web/Dockerfile
    volumes:
      - ./Caddyfile.tls:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    ports:
      - "80:80"
      - "443:443"
    restart: unless-stopped

volumes:
  foundry-data:
  relay-data:
  gateway-data:
  caddy-data:
  companion-runtime:
```

- [ ] **Step 2: Caddyfiles.** `stack/quickstart/Caddyfile` (HTTP default — same shape as `stack/Caddyfile`'s `:80` block):

```
# Quickstart default: plain HTTP — the PWA and its /api, same-origin.
# NOTE: over plain HTTP on a LAN IP the PWA loses installability/offline
# (secure-context requirement); remote players use the TLS profile instead.

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
```

  `stack/quickstart/Caddyfile.tls.example` (the CLI copies this to `Caddyfile.tls`, replacing the three placeholders):

```
# TLS profile template — `make setup` instantiates this as Caddyfile.tls,
# replacing {{DOMAIN_APP}}, {{DOMAIN_VTT}}, {{ACME_EMAIL}}.
{
	email {{ACME_EMAIL}}
}

{{DOMAIN_APP}} {
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

{{DOMAIN_VTT}} {
	reverse_proxy foundry:30000
}
```

- [ ] **Step 3: Example files.** `stack/quickstart/.env.example`:

```
# Non-secret knobs only (secret values live in secrets/*, never here —
# this file IS compose-interpolated).
HOST_PORT_WEB=8080
HOST_PORT_FOUNDRY=30000
HOST_PORT_RELAY=3010
HOST_PORT_STATUS=8321
# TLS profile (make setup fills these when you opt in):
# COMPOSE_PROFILES=tls
# FOUNDRY_PROXY_SSL=true
# FOUNDRY_PROXY_PORT=443
```

  `stack/quickstart/secrets/foundry-config.json.example` (keys per Task 0 findings §2):

```json
{
  "foundry_username": "you@example.com",
  "foundry_password": "your-foundry-password",
  "foundry_license_key": "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  "foundry_admin_key": "generated-by-make-setup"
}
```

  `stack/quickstart/secrets/bootstrap.env.example`:

```
# All values are GENERATED by `make setup` (base64url, symbol-safe).
RELAY_ACCOUNT_EMAIL=bootstrap@companion.local
RELAY_ACCOUNT_PASSWORD=generated-by-make-setup
FOUNDRY_GM_USER=Gamemaster
FOUNDRY_GM_PASSWORD=generated-by-make-setup
FOUNDRY_ADMIN_KEY=generated-by-make-setup
```

  `stack/quickstart/secrets/gateway.env.example`:

```
# Generated by `make setup`. Enables the /admin invite console.
ADMIN_PASSWORD=generated-by-make-setup
```

  Append to `.gitignore` (keep the `.example` files tracked):

```
# turnkey quickstart — generated by `make setup`, never committed
stack/quickstart/.env
stack/quickstart/Caddyfile.tls
stack/quickstart/secrets/*
!stack/quickstart/secrets/*.example
```

- [ ] **Step 4: Validate** (the "test" for a compose task): create local copies so compose can resolve every reference, then ask compose to parse:

```bash
cd stack/quickstart
cp .env.example .env
cp secrets/foundry-config.json.example secrets/foundry-config.json
cp secrets/bootstrap.env.example secrets/bootstrap.env
cp secrets/gateway.env.example secrets/gateway.env
docker compose config -q && echo COMPOSE-OK
docker compose --profile tls config -q 2>&1 | head -3   # expected to FAIL: Caddyfile.tls missing
cp Caddyfile.tls.example Caddyfile.tls
docker compose --profile tls config -q && echo TLS-COMPOSE-OK
git status --porcelain stack/quickstart   # expected: ONLY .example files + compose + Caddyfile listed as new; no .env, no secrets/*.env, no Caddyfile.tls
```

Expected: `COMPOSE-OK`, then `TLS-COMPOSE-OK`, and gitignore proven by the last command. Also verify the regression gate: `git diff --name-only` shows NO change under `stack/docker-compose.dev.yml` / `stack/docker-compose.prod.yml` / `stack/Caddyfile`.

- [ ] **Step 5: Commit**

```bash
git add stack/quickstart/docker-compose.yml stack/quickstart/Caddyfile stack/quickstart/Caddyfile.tls.example stack/quickstart/.env.example stack/quickstart/secrets/foundry-config.json.example stack/quickstart/secrets/bootstrap.env.example stack/quickstart/secrets/gateway.env.example .gitignore
git commit -m "feat(stack): quickstart compose (self-wiring, socket-free, TLS profile)"
```

---

### Task 9: `make setup` — host-side quickstart CLI

**Files:**
- Create: `scripts/setup-quickstart.mjs`, `Makefile`, `apps/bootstrap/test/mjs.d.ts`
- Test: `apps/bootstrap/test/setup-cli.test.ts` (the CLI is dependency-free host-side ESM; its pure builder functions are exported and tested from the bootstrap package's vitest — the one place in the repo with a test runner able to import them)

**Interfaces:**
- Consumes: the file contracts of Task 8 (`.env` knob names, secrets file names/keys, `Caddyfile.tls` placeholders).
- Produces (exported from `scripts/setup-quickstart.mjs`; plain ESM, node: builtins only):

```js
export function generateSecret(bytes = 18): string            // base64url -> symbol-safe by construction
export function buildFoundryConfigJson(i: { username: string; password: string; licenseKey: string; adminKey: string }): string
export function buildBootstrapEnv(s: { relayEmail: string; relayPassword: string; gmUser: string; gmPassword: string; adminKey: string }): string
export function buildGatewayEnv(s: { adminPassword: string }): string
export function buildDotEnv(k: { tls: boolean }): string
export function buildTlsCaddyfile(t: { domainApp: string; domainVtt: string; acmeEmail: string }): string
export function detectComposeCommand(run?: (cmd: string, args: string[]) => { status: number | null }): string[] | null
```

Behavior contract: **idempotent** — every config/secret file is write-if-absent (existing files are kept and their secrets NOT echoed again); `--reset` deletes the generated files (`.env`, `Caddyfile.tls`, `secrets/*` except `*.example`) after an explicit y/N confirm, volumes untouched; `--no-up` skips the compose run. Generated secrets are printed EXACTLY once, in a clearly framed block, with the operator to-do list (create world; set the Gamemaster password to the printed one; enable the module; set wsRelayUrl per findings §5; launch). Passwords typed at the prompts are read with echo ON (documented limitation; server-console setup). Runtime autodetect order: `docker compose version` → `podman compose version` → `podman-compose version`; none ⇒ print install hint and exit 1.

- [ ] **Step 1: Write the failing tests** — `apps/bootstrap/test/setup-cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapEnv,
  buildDotEnv,
  buildFoundryConfigJson,
  buildGatewayEnv,
  buildTlsCaddyfile,
  detectComposeCommand,
  generateSecret,
} from '../../../scripts/setup-quickstart.mjs';

describe('generateSecret', () => {
  it('is base64url (symbol-safe: no $, no quotes, no spaces) and long enough', () => {
    for (let i = 0; i < 50; i++) {
      const s = generateSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
  });
});

describe('file builders', () => {
  it('buildFoundryConfigJson emits exactly the felddy secret keys', () => {
    const json = JSON.parse(
      buildFoundryConfigJson({ username: 'u@x.y', password: 'p$w', licenseKey: 'L-1', adminKey: 'A-1' }),
    );
    expect(json).toEqual({
      foundry_username: 'u@x.y',
      foundry_password: 'p$w',
      foundry_license_key: 'L-1',
      foundry_admin_key: 'A-1',
    });
  });

  it('buildFoundryConfigJson omits the license key when empty (felddy fetches it from the account)', () => {
    const json = JSON.parse(buildFoundryConfigJson({ username: 'u', password: 'p', licenseKey: '', adminKey: 'a' }));
    expect(json.foundry_license_key).toBeUndefined();
  });

  it('buildBootstrapEnv emits the exact sidecar env contract', () => {
    expect(
      buildBootstrapEnv({ relayEmail: 'b@c.local', relayPassword: 'rp', gmUser: 'Gamemaster', gmPassword: 'gp', adminKey: 'ak' }),
    ).toBe(
      'RELAY_ACCOUNT_EMAIL=b@c.local\nRELAY_ACCOUNT_PASSWORD=rp\nFOUNDRY_GM_USER=Gamemaster\nFOUNDRY_GM_PASSWORD=gp\nFOUNDRY_ADMIN_KEY=ak\n',
    );
  });

  it('buildGatewayEnv emits ADMIN_PASSWORD', () => {
    expect(buildGatewayEnv({ adminPassword: 'ap' })).toBe('ADMIN_PASSWORD=ap\n');
  });

  it('buildDotEnv: HTTP default vs TLS profile', () => {
    expect(buildDotEnv({ tls: false })).toBe(
      'HOST_PORT_WEB=8080\nHOST_PORT_FOUNDRY=30000\nHOST_PORT_RELAY=3010\nHOST_PORT_STATUS=8321\n',
    );
    expect(buildDotEnv({ tls: true })).toBe(
      'HOST_PORT_WEB=8080\nHOST_PORT_FOUNDRY=30000\nHOST_PORT_RELAY=3010\nHOST_PORT_STATUS=8321\nCOMPOSE_PROFILES=tls\nFOUNDRY_PROXY_SSL=true\nFOUNDRY_PROXY_PORT=443\n',
    );
  });

  it('buildTlsCaddyfile replaces all three placeholders', () => {
    const out = buildTlsCaddyfile({ domainApp: 'app.ex.com', domainVtt: 'vtt.ex.com', acmeEmail: 'ops@ex.com' });
    expect(out).toContain('app.ex.com {');
    expect(out).toContain('vtt.ex.com {');
    expect(out).toContain('email ops@ex.com');
    expect(out).not.toContain('{{');
  });
});

describe('detectComposeCommand', () => {
  it('prefers docker compose, falls back to podman compose, then podman-compose, else null', () => {
    const ok = { status: 0 };
    const nope = { status: 1 };
    expect(detectComposeCommand(() => ok)).toEqual(['docker', 'compose']);
    expect(detectComposeCommand((cmd) => (cmd === 'docker' ? nope : ok))).toEqual(['podman', 'compose']);
    expect(detectComposeCommand((cmd) => (cmd === 'podman-compose' ? ok : nope))).toEqual(['podman-compose']);
    expect(detectComposeCommand(() => nope)).toBeNull();
  });
});
```

  and `apps/bootstrap/test/mjs.d.ts` (the bootstrap tsconfig has no types for a repo-root `.mjs` — declare exactly the surface the test imports):

```ts
/** Typed surface of scripts/setup-quickstart.mjs for the vitest import —
 *  runtime behavior is what the tests exercise; keep in sync with the CLI. */
declare module '*setup-quickstart.mjs' {
  export function generateSecret(bytes?: number): string;
  export function buildFoundryConfigJson(i: {
    username: string;
    password: string;
    licenseKey: string;
    adminKey: string;
  }): string;
  export function buildBootstrapEnv(s: {
    relayEmail: string;
    relayPassword: string;
    gmUser: string;
    gmPassword: string;
    adminKey: string;
  }): string;
  export function buildGatewayEnv(s: { adminPassword: string }): string;
  export function buildDotEnv(k: { tls: boolean }): string;
  export function buildTlsCaddyfile(t: { domainApp: string; domainVtt: string; acmeEmail: string }): string;
  export function detectComposeCommand(
    run?: (cmd: string, args: string[]) => { status: number | null },
  ): string[] | null;
}
```

- [ ] **Step 2: Run tests, see them fail**

Run: `pnpm --filter @companion/bootstrap test -- setup-cli`
Expected: FAIL — `Cannot find module '../../../scripts/setup-quickstart.mjs'`.

- [ ] **Step 3: Implement** — `scripts/setup-quickstart.mjs`:

```js
#!/usr/bin/env node
/**
 * Turnkey quickstart setup (spec Phase 1, host-side by design: writing files
 * and running `compose up` from the host needs no runtime socket and no
 * restart choreography). Prompts for the MINIMUM (foundry.com credentials;
 * optionally TLS domains), GENERATES everything else (base64url — symbol-
 * safe by construction), writes stack/quickstart config + secret files
 * (0600), prints the generated secrets ONCE, and runs compose up.
 * Idempotent: existing files are kept (secrets never re-echoed); --reset
 * wipes generated files (volumes untouched); --no-up skips the compose run.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QDIR = join(REPO_ROOT, 'stack', 'quickstart');
const SECRETS = join(QDIR, 'secrets');

export function generateSecret(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export function buildFoundryConfigJson({ username, password, licenseKey, adminKey }) {
  // Key names per Task 0 findings §2 (felddy 13.351.0 secrets file).
  const cfg = { foundry_username: username, foundry_password: password };
  if (licenseKey !== '') cfg.foundry_license_key = licenseKey;
  cfg.foundry_admin_key = adminKey;
  return JSON.stringify(cfg, null, 2) + '\n';
}

export function buildBootstrapEnv({ relayEmail, relayPassword, gmUser, gmPassword, adminKey }) {
  return (
    `RELAY_ACCOUNT_EMAIL=${relayEmail}\n` +
    `RELAY_ACCOUNT_PASSWORD=${relayPassword}\n` +
    `FOUNDRY_GM_USER=${gmUser}\n` +
    `FOUNDRY_GM_PASSWORD=${gmPassword}\n` +
    `FOUNDRY_ADMIN_KEY=${adminKey}\n`
  );
}

export function buildGatewayEnv({ adminPassword }) {
  return `ADMIN_PASSWORD=${adminPassword}\n`;
}

export function buildDotEnv({ tls }) {
  const lines = ['HOST_PORT_WEB=8080', 'HOST_PORT_FOUNDRY=30000', 'HOST_PORT_RELAY=3010', 'HOST_PORT_STATUS=8321'];
  if (tls) lines.push('COMPOSE_PROFILES=tls', 'FOUNDRY_PROXY_SSL=true', 'FOUNDRY_PROXY_PORT=443');
  return lines.join('\n') + '\n';
}

export function buildTlsCaddyfile({ domainApp, domainVtt, acmeEmail }) {
  const template = readFileSync(join(QDIR, 'Caddyfile.tls.example'), 'utf8');
  return template
    .replaceAll('{{DOMAIN_APP}}', domainApp)
    .replaceAll('{{DOMAIN_VTT}}', domainVtt)
    .replaceAll('{{ACME_EMAIL}}', acmeEmail);
}

export function detectComposeCommand(run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' })) {
  if (run('docker', ['compose', 'version']).status === 0) return ['docker', 'compose'];
  if (run('podman', ['compose', 'version']).status === 0) return ['podman', 'compose'];
  if (run('podman-compose', ['version']).status === 0) return ['podman-compose'];
  return null;
}

function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '<this-host-ip>';
}

function writeSecretIfAbsent(path, content) {
  if (existsSync(path)) return false;
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows dev box */
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (args.includes('--reset')) {
      const sure = (await rl.question('Delete generated quickstart config + secrets (volumes untouched)? [y/N] ')).trim();
      if (sure.toLowerCase() !== 'y') return;
      for (const f of ['.env', 'Caddyfile.tls']) rmSync(join(QDIR, f), { force: true });
      if (existsSync(SECRETS)) {
        for (const f of ['foundry-config.json', 'bootstrap.env', 'gateway.env']) rmSync(join(SECRETS, f), { force: true });
      }
      console.log('reset done — run `make setup` to start over.');
      return;
    }

    mkdirSync(SECRETS, { recursive: true });
    try {
      chmodSync(SECRETS, 0o700);
    } catch {
      /* windows dev box */
    }

    const generated = [];

    if (!existsSync(join(SECRETS, 'foundry-config.json'))) {
      console.log('foundryvtt.com credentials (used by the container to download Foundry v13):');
      const username = (await rl.question('  foundry.com username/email: ')).trim();
      const password = await rl.question('  foundry.com password (input is visible): ');
      const licenseKey = (await rl.question('  license key (Enter = fetch from the account): ')).trim();
      const adminKey = generateSecret();
      writeSecretIfAbsent(join(SECRETS, 'foundry-config.json'), buildFoundryConfigJson({ username, password, licenseKey, adminKey }));
      const gmPassword = generateSecret();
      const relayPassword = generateSecret();
      writeSecretIfAbsent(
        join(SECRETS, 'bootstrap.env'),
        buildBootstrapEnv({
          relayEmail: 'bootstrap@companion.local',
          relayPassword,
          gmUser: 'Gamemaster',
          gmPassword,
          adminKey,
        }),
      );
      const adminPassword = generateSecret();
      writeSecretIfAbsent(join(SECRETS, 'gateway.env'), buildGatewayEnv({ adminPassword }));
      generated.push(
        ['Foundry admin key (setup screen)', adminKey],
        ['Gamemaster password (set this on the Gamemaster user in YOUR world)', gmPassword],
        ['Relay account (bootstrap@companion.local)', relayPassword],
        ['App admin console password (/admin)', adminPassword],
      );
    } else {
      console.log('secrets already present — keeping them (use `make setup-reset` to regenerate).');
    }

    if (!existsSync(join(QDIR, '.env'))) {
      const wantTls = (await rl.question('Enable HTTPS on your own domain? [y/N] ')).trim().toLowerCase() === 'y';
      if (wantTls) {
        const domainApp = (await rl.question('  app domain (e.g. app.example.com): ')).trim();
        const domainVtt = (await rl.question('  foundry domain (e.g. vtt.example.com): ')).trim();
        const acmeEmail = (await rl.question("  email for Let's Encrypt: ")).trim();
        writeFileSync(join(QDIR, 'Caddyfile.tls'), buildTlsCaddyfile({ domainApp, domainVtt, acmeEmail }), 'utf8');
      }
      writeFileSync(join(QDIR, '.env'), buildDotEnv({ tls: wantTls }), 'utf8');
    }

    if (generated.length > 0) {
      console.log('\n================ GENERATED SECRETS — SHOWN ONCE, WRITE THEM DOWN ================');
      for (const [label, value] of generated) console.log(`  ${label}:\n      ${value}`);
      console.log('==================================================================================\n');
    }

    const ip = lanIp();
    console.log('Next steps once the stack is up:');
    console.log(`  1. Foundry:      http://${ip}:30000  (EULA once, admin key above, create YOUR world)`);
    console.log('  2. In the world: set the Gamemaster user password to the generated one,');
    console.log('     enable the "Foundry REST API" module, set its WebSocket Relay URL to');
    console.log(`     ws://${ip}:3010  (Task 0 findings §5), then launch the world.`);
    console.log(`  3. Watch:        http://${ip}:8321  (setup status page)`);
    console.log(`  4. Play:         http://${ip}:8080  — invite players via /admin`);

    if (args.includes('--no-up')) return;
    const compose = detectComposeCommand();
    if (compose === null) {
      console.error('no container runtime found — install docker (with compose v2) or podman.');
      process.exitCode = 1;
      return;
    }
    console.log(`\nrunning: ${compose.join(' ')} up -d --build   (in stack/quickstart)`);
    const up = spawnSync(compose[0], [...compose.slice(1), 'up', '-d', '--build'], { cwd: QDIR, stdio: 'inherit' });
    process.exitCode = up.status ?? 1;
  } finally {
    rl.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('setup failed:', err.message);
    process.exit(1);
  });
}
```

  (If the `invokedDirectly` guard misbehaves on a platform, the safe simplification is `if (process.argv[1]?.endsWith('setup-quickstart.mjs'))` — behavior over cleverness; the guard exists only so vitest can import the module without running main.)

  `Makefile` (repo root — tabs, not spaces, for recipe lines):

```make
.PHONY: setup setup-reset

setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset
```

- [ ] **Step 4: Run tests, see them pass**

Run: `pnpm --filter @companion/bootstrap test -- setup-cli && pnpm --filter @companion/bootstrap typecheck`
Expected: PASS. Manual smoke (no stack started): `node scripts/setup-quickstart.mjs --no-up` in a scratch clone answers prompts and produces `stack/quickstart/.env` + three 0600 secret files + the once-only block; re-running prints "secrets already present". Then `pnpm typecheck && pnpm test` → green.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-quickstart.mjs Makefile apps/bootstrap/test/setup-cli.test.ts apps/bootstrap/test/mjs.d.ts
git commit -m "feat(setup): make setup — turnkey quickstart CLI"
```

---

### Task 10: Docs — HOSTING Part C, operations, version pins

**Files:**
- Modify: `docs/HOSTING.md` (new "Part C — Turnkey quickstart" after Part B; update the intro's "Two deployment shapes" line to three), `docs/OPERATIONS.md` (quickstart pointers in First deploy + Backups + Health), `VERSIONS.md` (module pin now also lives in `apps/bootstrap/Dockerfile`)

**Interfaces:** consumes everything above; produces the operator-facing contract Task 11 verifies word-by-word.

- [ ] **Step 1: HOSTING.md.** Change the intro list to three shapes (add: `- **C. Turnkey** — one command on a server with docker or rootless podman; the stack wires itself.`). Append after Part B:

```markdown
---

## Part C — Turnkey quickstart (docker or rootless podman)

One `make setup` on an Ubuntu server. No manual relay pairing, no key
juggling: a bootstrap sidecar registers the relay account, mints the
gateway's API key at runtime (hands it over on a shared volume — the gateway
hot-reloads it), pre-installs the REST module, and keeps your world online
headlessly. You bring your own world.

### C1. Prerequisites

- Ubuntu (or similar) with **docker + compose v2** OR **rootless podman ≥4**.
  With podman, `env_file: format: raw` needs a compose provider that supports
  it — see `docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md`
  §3 for the verified provider.
- Node 22 (`corepack enable`) — the setup CLI and invite tooling run on it.
- A foundryvtt.com account (v13 license). Nothing else.
- Don't run this next to the dev/prod stack on one host without changing
  `HOST_PORT_*` in `stack/quickstart/.env` — default ports collide.

### C2. Setup

    make setup

Prompts: foundry.com credentials (license key optional — it can be fetched
from the account) and, only if you opt into HTTPS, `app`/`vtt` domains + an
email for Let's Encrypt. Everything else is generated and printed **once**:
the Foundry admin key, the **Gamemaster password** (you will set it on the
Gamemaster user of your world), the relay account password, and the `/admin`
console password. Write them down. The command ends by running
`docker compose up -d --build` (or the podman equivalent) itself.

Re-running `make setup` is safe (existing secrets are kept, never re-shown).
`make setup-reset` wipes the generated config/secrets (volumes stay).

### C3. First run — bring your own world

Watch `http://<server>:8321` (the status page — it tells you what to do and
where it is stuck). Then, on `http://<server>:30000`:

1. Accept the EULA, enter the admin key (printed by setup).
2. Install your game system (e.g. dnd5e — Foundry's Setup UI), **Create
   World**, launch it, join as **Gamemaster**.
3. Set the Gamemaster user's password to the printed one (User Management).
4. Enable the **Foundry REST API** module (already installed by the sidecar)
   and set its **WebSocket Relay URL** to `ws://<server>:3010`.
5. Relaunch/stay in the world. Within ~a minute the status page flips to
   **online** and `http://<server>:8080/healthz` shows
   `world: { state: "online", worldTitle: … }`.

If the status page shows **pair once**: follow its on-page steps (one-time
browser pairing — only needed if headless self-pairing is unavailable, see
the Task 0 findings; the relay account credentials are the ones setup
printed).

If it shows **GM login failed**: the Gamemaster password in the world does
not match `stack/quickstart/secrets/bootstrap.env`.

### C4. Invite players

`http://<server>:8080/admin`, log in with the printed admin password, **New
player** — same flow as A9. Over plain HTTP on a LAN IP the PWA loses
installability/offline (browsers require a secure context); remote players
should use the TLS profile.

### C5. HTTPS for remote players (opt-in)

Answer "y" to the TLS prompt in `make setup` (or re-run it after
`make setup-reset`). DNS for both domains must point at the server. Rootless
podman needs `sudo sysctl net.ipv4.ip_unprivileged_port_start=80` to bind
80/443. Players then use `https://app.<domain>/join#<token>`; Foundry is at
`https://vtt.<domain>`.

### C6. How the self-wiring works (for the curious)

`GET /healthz` merges three layers: gateway↔relay reachability, the world
resolution state (`RELAY_CLIENT_ID=auto`: the gateway follows the single
online world, caches it by worldId, refuses to guess when two worlds are
online — set an explicit `RELAY_CLIENT_ID` in that case), and the sidecar's
`status.json`. The relay API key never appears in any file you edit: the
sidecar owns `stack/quickstart` volume `companion-runtime:/run/companion/relay.env`
(mode 0600) and re-mints it automatically if the relay database is ever
wiped. After a server reboot, `restart: unless-stopped` + the sidecar
re-converge everything; if the world doesn't relaunch by itself, the status
page tells you (see the findings §2 for whether admin-API relaunch is active).
```

- [ ] **Step 2: OPERATIONS.md.** In "First deploy" add as line 1: `0. Turnkey path: `make setup` (docs/HOSTING.md Part C) replaces steps 2-6 below on a fresh server.` In "Backups" add a row: `| stack/quickstart/secrets/ | generated stack secrets (foundry creds, GM/relay/admin passwords) | include in the same backup job; companion-runtime volume is regenerable — no backup needed |`. In "Health" add: `- Quickstart: http://<server>:8321 (sidecar status page) and /healthz now includes world + bootstrap state.`

- [ ] **Step 3: VERSIONS.md.** In the `foundry-rest-api module` row, extend "Where it is pinned" with `+ apps/bootstrap/Dockerfile (baked module payload)`. In the relay row, extend with `+ stack/quickstart/docker-compose.yml`. Same for the Foundry image row.

- [ ] **Step 4: Verify + commit.** Proofread the three files against the actual Task 8/9 file names (paths, port numbers, `make` targets). `git diff --stat` must show only the three docs.

```bash
git add docs/HOSTING.md docs/OPERATIONS.md VERSIONS.md
git commit -m "docs: turnkey quickstart (HOSTING Part C, operations, pins)"
```

---

### Task 11: Live integration — docker + rootless podman table-loop

Operational, coordinator-led; no code except findings/ledger notes. Needs the Ubuntu/WSL2 host from Task 0(c) for the podman leg. **Do not run on the same host as the live dev stack without overriding `HOST_PORT_*`** (Pitfall 15).

- [ ] **Step 1 — docker leg, cold start.** Fresh checkout on the test host. `make setup` (real foundry.com creds; HTTP mode). Verify, in order:
  1. `docker compose ps` (in `stack/quickstart`) — foundry/relay/bootstrap/gateway/web all `Up`; nothing restart-looping (gateway must be Up-and-degraded, NOT crash-looping — that is the converge contract).
  2. Status page `:8321` walks `waiting-relay/minting-key → key-ready → waiting-world`.
  3. `docker compose exec gateway cat /run/companion/relay.env` → `RELAY_API_KEY=…` present, and `docker compose exec gateway ls -l /run/companion/relay.env` → `-rw------- … 3000` (0600, sidecar-owned, gateway can read).
  4. `curl -s localhost:8080/healthz` → `world: { state: "waiting", reason: "no-world-online" }`, `bootstrap.phase: "waiting-world"`.
- [ ] **Step 2 — bring your own world.** Follow HOSTING Part C3 exactly as written (this doubles as a docs test). Confirm the module was PRE-PLACED by the sidecar (it appears in Manage Modules without any manual zip drop). After launching the world: status page → `online`; `/healthz` → `world.state: "online"` with the worldTitle; no clientId string anywhere in the response.
- [ ] **Step 3 — table loop.** `/admin` with the printed password → create a player bound to a world actor → open the join link on a phone/browser → sheet renders → HP write round-trips (change in app, verify in Foundry, GM edit pushes back over SSE ≤3 s). If the world has a combat, sanity-check `/api/encounter` responds (proves `encounter:read` made it into the minted scope set — the HOSTING.md:149 regression this plan fixes).
- [ ] **Step 4 — convergence drills** (each must self-heal with NO manual restart):
  1. `docker compose restart relay` → status page dips, returns to `online`; sheet SSE resumes.
  2. Delete the key file: `docker compose exec bootstrap rm /run/companion/relay.env` → sidecar re-mints within ~1 poll + auth-backoff window; gateway hot-reloads (watch `docker compose logs gateway` for `relay identity changed; restarting relay-side streams`); table loop still works.
  3. Reboot simulation: `docker compose down && docker compose up -d` → everything returns to `online` — with a world relaunch either via the admin API (findings §2 GO) or via the documented status-page manual step (NO-GO).
  4. Rate-limit sanity: during all of the above, `docker compose logs bootstrap | grep -c '/auth'`-style inspection shows auth attempts spaced ≥60 s.
- [ ] **Step 5 — podman leg.** Same host or a second one: `make setup` detecting podman (`docker` absent or masked). Repeat Steps 1-3 (cold start, world, table loop) under rootless podman, plus the 0600-read check from Step 1.3. Record any provider-specific deltas in the findings §3.
- [ ] **Step 6 — regression + ledger.** On the dev machine: `pnpm typecheck && pnpm test` green; `git diff --name-only origin/main` contains NO change to `stack/docker-compose.dev.yml`, `stack/docker-compose.prod.yml`, `stack/Caddyfile`. Append a "live verification" section (dates, host details, drill outcomes) to the Task 0 findings doc and commit:

```bash
git add docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md
git commit -m "docs: turnkey quickstart live verification (docker + rootless podman)"
```

---

## Self-Review (done at plan-writing time)

**1. Spec coverage** (`2026-07-15-turnkey-stack-design.md`, section by section):
- Non-negotiables: socket-free/podman parity → Global Constraints + Task 8 (no socket mounts) + Task 0(c)/11; symbol-safe secrets → `format: raw` + file mounts + generated-base64url (Tasks 8/9, Pitfall 6); converge-never-restart → sidecar loop (Task 7), gateway degrade paths (Tasks 1/3/5), `up` runs once (Task 11 drills).
- Sidecar §1 key lifecycle (persist/probe/re-mint on 401/403, self-heal wiped-independently, atomic 0600 relay.env, exact scopes incl. `encounter:read` single-sourced) → Task 6 (`ensureKey`, `GATEWAY_KEY_SCOPES`, tests assert the exact list) + Task 11 Step 3/4.2.
- Sidecar §2 module pre-place, enable stays operator step, never write settings DB → Task 7 `module-install.ts` (never-overwrite test) + status-page/docs instructions.
- Sidecar §3 keep-online + Task 0(a) gate + fallback pairing → Task 0 spike a (incl. NO-GO fallback verification a7), Task 7 `session.ts` verdict switch + backoff (Pitfall 13).
- Sidecar §4 world relaunch (Task 0(b) gate, fallback documented) → Task 0 spike b4, Task 7 `foundry-admin.ts` (`ADMIN_RELAUNCH`), docs C6.
- Sidecar §5/§6 status.json + read-only status page, never renders secrets → Tasks 6 (`StatusWriter`), 7 (`status-page.ts`, escape test), 5 (gateway whitelist).
- Gateway: RELAY_API_KEY_FILE absent-at-boot + hot reload → Task 1; mutable creds → Task 2; `auto` policy 0/1/>1, cache-by-worldId, never-switch, bounded-probe-driven → Task 3 (policy encoded + tested); SSE re-subscription of all three streams → Task 4; `/healthz` (route is `/healthz`, no clientId exposed, merges status.json) → Task 5.
- TLS profile / HTTP default + PWA secure-context note → Tasks 8/10.
- Config model (`make setup` host-side, minimum prompts, generated-and-shown-once, idempotent, `--reset`) → Task 9.
- Data flow happy path → Task 11 Steps 1-3 mirror it verbatim. Error handling table → Tasks 6/7 (idempotent register, backoff), compose `restart: unless-stopped` (Task 8), gateway degrade + named failure classes (Tasks 3/5).
- Testing section: every listed unit case has a named test in Tasks 1-7; Task 0 spikes are Task 0; integration table-loop on both runtimes is Task 11; regression (dev/prod untouched, full suite green) is gated in Tasks 8/11.
- Out-of-scope items (demo content, Phase 2 wizard, rotation UI, multi-world, wizard ACME) — not implemented anywhere; the >1-online case explicitly refuses (Task 3).
- Gaps found and fixed during this review: (i) Task 7's `main.ts` originally set `starting-session` every pass — restructured to `worldOnline` + backoff-gated `attemptSession` so the sticky status survives between attempts; (ii) healthz legacy-shape preservation made explicit after noticing `app.test.ts` uses strict `toEqual`; (iii) `FOUNDRY_PROXY_PORT=${...:-}` empty-string behavior added to spike b3 because Task 8 depends on it.

**2. Placeholder scan:** no TBD/TODO/"add error handling"/"similar to Task N". Two **named latitudes** exist by design, both bounded to Task 0 findings: relay response field extraction in `relay-auth.ts` (fallback names already coded) and the `foundry-admin.ts` HTTP recipe (expected shape coded; findings §2 overrides). Both verdict switches (`HEADLESS_SELF_PAIR`, `ADMIN_RELAUNCH`) are single consts with the findings section that decides them cited at the definition site.

**3. Type/signature consistency:**
- `ApiKeySource.current(): string | null` (Task 1) ↔ server.ts `apiKey()` closure coalesces to `''` (Task 4) ↔ `RelayConfig.apiKey: string | (() => string)` (Task 2). ✓
- `ClientIdResolver.current(): string` ('' unresolved) ↔ `clientId: () => resolverRef?.current() ?? ''` (Task 4). `WorldHealth` defined once (Task 3), imported by app.ts (Task 5), asserted shape-identical in healthz tests. ✓
- `BootstrapStatusView` (gateway, Task 5) is the whitelisted READ shape of `BootstrapStatus` (sidecar, Task 6) — field names `phase/detail/error{class,message}/updatedAt` match; sidecar phases (Task 6 `BootstrapPhase`) match the GUIDANCE map keys (Task 7) one-to-one.
- `relayIdentityChanged?: (cb: () => void) => () => void` named identically in GatewayDeps (Task 4) and server.ts wiring (Task 4) and consumed in tests (Task 4). `restartStream()` spelled identically on LiveManager and EncounterManager.
- `GATEWAY_KEY_SCOPES` (Task 6) = HOSTING A6 list + `encounter:read`; provision test asserts array equality against the export, fake server records `mintedScopes`. ✓
- Compose env names (Task 8) = loadConfig names (Tasks 1/3/5: `RELAY_API_KEY_FILE`, `RELAY_CLIENT_ID`, `STATUS_FILE`, `PLAYERS_FILE`, `PORT`, `RELAY_URL`) and sidecar env names (Task 7 main.ts: `RELAY_URL`, `RELAY_ACCOUNT_EMAIL/PASSWORD`, `FOUNDRY_URL`, `FOUNDRY_GM_USER/PASSWORD`, `FOUNDRY_ADMIN_KEY`, `RUNTIME_DIR`, `FOUNDRY_DATA_DIR`, `STATUS_PORT`) = CLI builder outputs (Task 9 `buildBootstrapEnv`/`buildGatewayEnv`). Checked name-by-name. ✓
- Fixed inline during review: Task 7's session test imports `HEADLESS_SELF_PAIR` and branches on it so the test stays correct whichever verdict Task 0 sets; Task 9's `mjs.d.ts` uses a `*setup-quickstart.mjs` wildcard so the relative import path in the test resolves against it.
