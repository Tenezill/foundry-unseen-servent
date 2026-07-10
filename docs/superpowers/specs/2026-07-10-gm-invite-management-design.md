# GM invite management — design

**Date:** 2026-07-10
**Status:** approved (brainstorm with user)
**Milestone:** M18 (working name: "GM console")

## Problem

Creating a player invite today requires a terminal: run
`scripts/make-invite.mjs`, hand-edit `apps/gateway/players.yaml`, then restart
the gateway because `players.yaml` is only read at startup. Live-demonstrated
2026-07-10: minting one link meant killing a detached `nohup` gateway process.
No GM without shell access to the gateway host can onboard a player.

## Goal

A GM logged into the PWA can, without a terminal:

- see the list of linked players (name, linked actors, GM flag),
- create a new player link ("New player" button → name + actor picker →
  join link shown once, with QR code),
- revoke a player's access,
- rotate (regenerate) a player's link.

## Non-goals (v1)

- Mapping Foundry *user accounts* to characters. The relay's `players` action
  returns users without their assigned character; ownership is only derivable
  per-actor from `ownership` maps. Deferred as a picker nicety.
- Invite expiry dates, per-invite scopes, or multi-world support.
- Replacing `scripts/make-invite.mjs` — it stays unchanged as a scripting
  alternative; it is no longer required for anything.
- Setting `gm: true` (M9 roll-feed flag) from the console. The flag keeps its
  roll-feed meaning and stays hand-editable; it no longer gates anything else.

## Access model

Admin credential hardcoded in the gateway's env file (user decision: least
hassle, works unchanged if the project goes open source — every deployment
sets its own secret):

- `.env` gains `ADMIN_PASSWORD`. When it is **unset or empty, the admin
  surface is disabled entirely** (`/api/admin/*` returns 404) — secure
  default for deployments that never opt in.
- The web app gets an `/admin` page with a password login form. The password
  is kept client-side (localStorage, same pattern as the player token) and
  sent as `Authorization: Bearer <password>` on `/api/admin/*` requests.
- The gateway verifies with a timing-safe comparison (sha256 both sides,
  same technique as invite tokens). Wrong/missing credential → 401.
- Player invite tokens grant **no** admin access; the two credential spaces
  never mix. `/api/me` and the player flow are untouched.
- No server-side session state; "logout" is just clearing the stored secret.
- Transport security is the deployment's HTTPS (Caddy in prod, LAN in dev) —
  same trust model as invite tokens today.

Bootstrap: write one line into `.env`, restart the gateway once. No
chicken-and-egg, no CLI minting.

## Gateway

### PlayerStore (new module, replaces load-once)

A single owner for `players.yaml` reads *and* writes:

- **Load** at startup (existing `loadPlayers` validation reused verbatim).
- **Hot reload:** watch the file (`fs.watch`, debounced) so hand edits apply
  without a restart — this fixes today's restart pain for CLI users too. A
  reload that fails validation logs the error and keeps the last good state.
- **Write:** serialize mutations (in-process queue); write atomically
  (temp file in the same directory + rename). Writes go through the same
  validator before hitting disk.
- **Normalization caveat (documented in the file header we emit):** gateway
  rewrites are generated YAML — hand-written comments do not survive a
  UI-driven change. The emitted file carries a `# managed by the gateway`
  header saying so.
- Token verification behavior is unchanged (sha256 digests, timing-safe
  comparison over all entries).

### Endpoints

All under the existing Fastify app, guarded by a `requireAdmin` pre-handler
(timing-safe check against `ADMIN_PASSWORD`; 404 when the feature is
disabled, 401 on bad/missing credential).

| Method & path | Body → Result |
| --- | --- |
| `GET /api/admin/players` | → `{ players: [{ name, gm, actors: [{ id, name? }] }] }`. Never includes hashes. Actor names resolved via the relay (best-effort; unresolvable ids render as the raw id). |
| `POST /api/admin/players` | `{ name, actorIds }` → `{ token, player }`. Token: 24 random bytes, base64url (same as the CLI script). Only the sha256 hash is stored. **The plaintext token appears exactly once, in this response.** 409 on duplicate name (case-insensitive). 422 on empty name/actorIds. |
| `POST /api/admin/players/:name/rotate` | → `{ token }`. Replaces the entry's hash; old link dies immediately. 404 for unknown name. |
| `DELETE /api/admin/players/:name` | → 204. Revokes access immediately. Any entry may be deleted — admin access lives in `.env`, so there is no lockout to guard against. |
| `GET /api/admin/actors` | → `{ actors: [{ id, name, img? }] }` — world actors of type `character`, via the relay search (mind the M13 `subType` vs `type` quirk). Backs the picker. |

Names are used in URL paths → the web client encodes them; the gateway
validates `:name` against the same rules as creation.

### Logging / secrets

Plaintext tokens and the admin password must never reach structured logs.
The gateway already redacts its own secrets; the admin routes additionally
exclude response bodies (and the `token` field specifically) from request
logging.

## Web UI

New page `app/pages/admin.vue` (route `/admin`), reached by URL plus a
discreet "Admin" link in the home-screen footer (always shown — it leads to
the login form, which is harmless without the credential). The page has two
states:

- **Login:** a single password field; on success the credential persists in
  localStorage and the console renders. A 404 from the gateway shows
  "Admin access is not enabled on this server."
- **Console** (everything below).

- **Player list:** one row per entry — name, actor chips (resolved names),
  GM badge, overflow actions *Rotate link* and *Revoke*. Both destructive
  actions use the existing ConfirmDialog; revoke warns it is immediate.
- **"New player" button** → bottom sheet (existing modal-sheet pattern):
  name field + actor picker (multi-select from `GET /api/admin/actors`, with
  search filter) → Create.
- **Invite result view** (shared by create and rotate): the join link built
  client-side as `${location.origin}/join#${token}`, a QR code of that link,
  a Copy button, and a "shown once — it isn't stored anywhere" notice.
  Leaving the view discards the token.
- **QR code:** generated client-side (`uqr`, zero-dependency SVG string —
  compatible with the PWA's strict offline/CSP posture). No network involved.

Visual language follows the existing Gilded Tome components (SectionList
rows, modal sheets, ConfirmDialog, toasts).

## Error handling

- Gateway write failures (disk, validation) → 500 with a generic message;
  the in-memory list is only swapped after a successful write.
- Relay unavailable for actor-name resolution → list still renders with raw
  ids; picker shows a retryable error state.
- Web: reuse toast + error conventions; a 401 on any `/api/admin/*` call
  drops the stored credential and returns the page to the login state.

## Testing

- **PlayerStore unit tests:** load/validate (reusing existing cases), atomic
  write round-trip, hot-reload on external change, invalid-reload keeps last
  good state, write serialization.
- **Gateway app tests** (temp-dir `players.yaml`): create → token verifies
  via `/api/me`; duplicate-name 409; rotate kills the old token; revoke kills
  access; `ADMIN_PASSWORD` unset → 404 on every `/api/admin/*` route; wrong
  password → 401; a player invite token → 401 on admin routes; tokens and
  password absent from logs and from `GET /api/admin/players`.
- **Web:** login/disabled/console state rendering; live-verify checklist —
  log in at `/admin`, create a player from the PWA, scan the QR with a phone,
  join, see the sheet; rotate and confirm the old link dies; revoke and
  confirm 401.

## Runbook impact

`docs/LLM-SETUP-RUNBOOK.md` Phase 5 shrinks to: set `ADMIN_PASSWORD` in the
gateway `.env`, open `/admin`, create invites there. `make-invite.mjs` is
demoted to an optional scripting note. The Lifetimes section gains:
players.yaml is gateway-managed and hot-reloaded; hand edits no longer
require a restart.
