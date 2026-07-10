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
- Replacing `scripts/make-invite.mjs` — it stays as the bootstrap path that
  mints the first `gm: true` entry. It gains a `--gm` flag as part of this
  milestone (today it cannot emit `gm: true`; the operator would hand-edit).

## Access model

`players.yaml` entries already support `gm?: boolean` (M9, roll feed). That
flag now also gates the GM console:

- `/api/me` already returns `gm` — the web app shows a "Manage players" entry
  on the home screen when it is `true`.
- All new endpoints live under `/api/gm/*` and return **403** for tokens whose
  player entry lacks `gm: true`. Unauthenticated requests stay 401.

Bootstrap: the operator marks their own entry `gm: true` (hand-edit or
`make-invite.mjs --gm`). This is a one-time setup step already covered by the
runbook's invite phase.

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

All under the existing Fastify app, guarded by a `requireGm` pre-handler.

| Method & path | Body → Result |
| --- | --- |
| `GET /api/gm/players` | → `{ players: [{ name, gm, actors: [{ id, name? }] }] }`. Never includes hashes. Actor names resolved via the relay (best-effort; unresolvable ids render as the raw id). |
| `POST /api/gm/players` | `{ name, actorIds }` → `{ token, player }`. Token: 24 random bytes, base64url (same as the CLI script). Only the sha256 hash is stored. **The plaintext token appears exactly once, in this response.** 409 on duplicate name (case-insensitive). 422 on empty name/actorIds. |
| `POST /api/gm/players/:name/rotate` | → `{ token }`. Replaces the entry's hash; old link dies immediately. 404 for unknown name. |
| `DELETE /api/gm/players/:name` | → 204. Revokes access immediately. **409 if the entry is the last `gm: true` player** — deleting it would lock the UI path permanently (recovery would be CLI-only). Rotating the last GM is allowed (the caller receives the new token). |
| `GET /api/gm/actors` | → `{ actors: [{ id, name, img? }] }` — world actors of type `character`, via the relay search (mind the M13 `subType` vs `type` quirk). Backs the picker. |

Names are used in URL paths → the web client encodes them; the gateway
validates `:name` against the same rules as creation.

### Logging / secrets

Plaintext tokens must never reach structured logs. The gateway already
redacts its own secrets; the GM routes additionally exclude response bodies
(and the `token` field specifically) from request logging.

## Web UI

New page `app/pages/gm.vue` (route `/gm`), reachable from a "Manage players"
affordance on the actor-select home screen, rendered only when `me.gm`.
Direct navigation without the flag shows the 403 state ("Ask your GM").

- **Player list:** one row per entry — name, actor chips (resolved names),
  GM badge, overflow actions *Rotate link* and *Revoke*. Both destructive
  actions use the existing ConfirmDialog; revoke warns it is immediate.
- **"New player" button** → bottom sheet (existing modal-sheet pattern):
  name field + actor picker (multi-select from `GET /api/gm/actors`, with
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
- Web: reuse toast + error conventions; 401/403 on `/gm` routes fall back to
  the join/ask-your-GM states.

## Testing

- **PlayerStore unit tests:** load/validate (reusing existing cases), atomic
  write round-trip, hot-reload on external change, invalid-reload keeps last
  good state, write serialization.
- **Gateway app tests** (temp-dir `players.yaml`): create → token verifies
  via `/api/me`; duplicate-name 409; rotate kills the old token; revoke kills
  access; last-GM delete 409; non-GM token → 403 on every `/api/gm/*` route;
  tokens absent from logs and from `GET /api/gm/players`.
- **Web:** component-level rendering of GM affordance by `me.gm`;
  live-verify checklist — create a player from the PWA, scan the QR with a
  phone, join, see the sheet; rotate and confirm the old link dies; revoke
  and confirm 401.

## Runbook impact

`docs/LLM-SETUP-RUNBOOK.md` Phase 5 shrinks to: mint **one** GM invite via
CLI (`make-invite.mjs --gm <name> <actorId…>`), everything else via the PWA.
The Lifetimes section gains: players.yaml is gateway-managed and hot-reloaded;
hand edits no longer require a restart.
