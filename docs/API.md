# Gateway HTTP API (v1)

The PWA talks **only** to the gateway. The relay, its API key, and Foundry
credentials never appear in any client-visible response.

Base path: `/api`. All responses are JSON unless noted.

## Authentication

Every request carries the player's invite token:

```
Authorization: Bearer <token>
```

Exception: `GET /api/actors/:id/events` (SSE — `EventSource` cannot set
headers) also accepts `?token=<token>`.

- Missing/unknown token → `401 {"error":{"code":"UNAUTHORIZED","message":…}}`
- Token valid but actor not owned by the player → `404` (not 403 — do not
  leak actor existence).

Tokens are verified against `players.yaml` (mounted secret):

```yaml
players:
  - name: Anna
    tokenHash: "<sha256 hex of the invite token>"
    actorIds: ["kbXH9…", "aa3F2…"]
```

## Endpoints

### `GET /api/me`
→ `200 { "player": { "name": "Anna", "actorIds": ["kbXH9…"] } }`

### `GET /api/actors`
Summaries of the player's own actors only.
→ `200 { "actors": [ { "id": "kbXH9…", "name": "Sariel", "img": "…", "systemId": "dnd5e" } ] }`

### `GET /api/party`
Roster for the out-of-combat buff target picker (see `cast`'s `targetActorId`
below): the deduped union of **every** player's `actorIds`, not just the
caller's own.
→ `200 { "actors": [ { "id": "kbXH9…", "name"?: "Sariel", "img"?: "…" } ] }`

`name`/`img` are resolved best-effort via the relay (same bounded lookup
pattern as `GET /api/admin/players`); an id that can't be resolved (e.g.
deleted in Foundry) is returned bare — `{ "id": "ghost-id" }`, no `name`/`img`
keys. Requires only a valid player token — no actor-ownership check (any
authenticated player may see the full roster, by design).

### `GET /api/actors/:id/sheet`
Full `SheetViewModel` (see `packages/adapter-sdk`).
→ `200 { "sheet": SheetViewModel }`

The view model also carries (M8): `conditions` (active effects as badges),
`concentration` (`{label}` of the concentrated spell or `null`), and, on list
items, an optional `detail` (the item's own description HTML from the world,
for a detail view — the client sanitizes it). List sections (M19) may carry
an optional `header` item (e.g. inventory sections: `inventory` for "Carried",
`inventory.<containerId>` per container — each may have a header showing the
container's name and weight).

Multi-system additions (M23, second adapter `adapter-wod5e`): an optional
`tabs` array (`{id, label, sectionIds, hostsActions?}`) — the adapter's own
tab layout; absent means the PWA falls back to its legacy heuristic. An
optional `glyph` (single character/emoji, e.g. wod5e's clan sigil) for actors
whose `img` is unset or generic. An optional `customItems` array
(`{type, label, hasDamage}`) naming the item types the player may create from
a form — see `POST /api/actors/:id/items` below. A `Stat` may carry
`display: 'dots'` with a `max` to render `value` as a dot row (0..max)
instead of text (wod5e attributes/skills). A `tracks` section may carry
`boxTracks` (`{id, label, max, primaryId, aggravatedId?}`) alongside its
plain `resourceIds` trackers — a box-rendered track, tri-state
(empty/superficial/aggravated) when `aggravatedId` is set, two-state
otherwise (wod5e health/willpower vs. hunger/stains).

### `GET /api/actors/:id/movement`

Movement context for the actor's token on the ACTIVE scene (square grids only).
`{ movement: { onScene, sceneId?, gridDistance?, gridUnits?, speedFt?, token?: {cx,cy}, others?: [{cx,cy,disposition,name?}] } }`
`onScene:false` when there is no active scene, the grid is not square, or the
actor has no token there. Coordinates are grid cells, never pixels. GM-hidden
tokens are stripped server-side. Multi-square tokens contribute one `others`
entry per covered cell (same `disposition`/`name` on each), so a 2×2 monster
occupies all 4 of its cells, not just its anchor. 404 foreign/unknown actor;
502 relay failure.

### `POST /api/actors/:id/movement`

Body `{ cx, cy }` (grid cell). Validates ownership (404), range (422
INVALID_INTENT, Chebyshev ≤ floor(speed/gridDistance)), occupancy by visible
tokens (409 CONFLICT), token-on-scene (409). On success moves the token in
Foundry (animated, straight line) and returns `{ movement }` with the token at
the new cell. 429 rate-limited; 502 relay failure/stall, including a stall
while fetching the active scene (distinct from the relay answering "no active
scene", which is the 409 above).

### `POST /api/actors/:id/intents`
Body: a single `ResourceIntent`:

```json
{ "kind": "delta", "resourceId": "hp", "amount": -7, "expected": 24 }
{ "kind": "set",   "resourceId": "slots.3", "value": 1, "expected": 2 }
```

Semantics (server-enforced, in this order):
1. Actor must be owned by the token → else `404`.
2. `resourceId` must exist and be `writable` → else `403 FORBIDDEN_RESOURCE`.
3. Payload must validate (numbers finite, kind known) → else `422 INVALID_INTENT`.
4. If `expected` is present and differs from the current value → `409
   {"error":{"code":"CONFLICT"},"sheet":<fresh SheetViewModel>}` (no write).
5. Result is clamped to the descriptor's `[min, max]`, written to Foundry via
   the relay, then the fresh sheet is returned:
   `200 { "sheet": SheetViewModel }`.

Rate limit: 30 write intents/min per token → `429 RATE_LIMITED`.

### `POST /api/actors/:id/actions` (M6)
Trigger a sheet action. The sheet's `actions` array (`ActionDescriptor[]`)
lists everything legal; `actionId` must reference one of them.

```json
{ "kind": "check",  "actionId": "skill.ath", "mode": "advantage" }
{ "kind": "save",   "actionId": "ability.con.save" }
{ "kind": "attack", "actionId": "item.X3ab9.attack" }
{ "kind": "cast",   "actionId": "spell.k9Q2f.cast" }
{ "kind": "cast",   "actionId": "spell.k9Q2f.cast", "targetActorId": "kbXH9…" }
{ "kind": "attack", "actionId": "item.X3ab9.attack", "targetTokenUuids": ["Scene.abc123.Token.def456"] }
{ "kind": "cast",   "actionId": "spell.k9Q2f.cast", "slotLevel": 4, "targetTokenUuids": ["Scene.abc123.Token.def456", "Scene.abc123.Token.ghi789"] }
{ "kind": "use",    "actionId": "feature.p0Wm1.use" }
{ "kind": "equip",  "actionId": "item.X3ab9.equip", "equipped": false }
{ "kind": "move",   "actionId": "item.X3ab9.move", "containerId": "wYUZWMKa6FntpIvv" }
{ "kind": "move",   "actionId": "item.X3ab9.move", "containerId": null }
{ "kind": "rest",   "actionId": "rest.short" }
{ "kind": "rest",   "actionId": "rest.long" }
{ "kind": "deathsave",       "actionId": "deathsave.roll" }
{ "kind": "endconcentration","actionId": "concentration.end" }
{ "kind": "pool",   "actionId": "pool.skill.athletics", "attribute": "attr.strength", "skill": "skill.athletics", "modifier": 1 }
{ "kind": "rouse",  "actionId": "rouse" }
```

The M8 actor-command kinds (`rest`/`deathsave`/`endconcentration`) take no
item target; the gateway runs the matching relay command
(`short-rest`/`long-rest`/`death-save`/`break-concentration`) and returns the
fresh sheet (`result` null — these post their own chat card). `cast` no longer
takes `slotLevel`: the bridge casts at base level only (see M6 known limits).

`cast` also accepts an optional `targetActorId` (target-buffs feature): the
copied effect from a creature-targetable buff (e.g. Bless, Aid) is applied to
that actor instead of the caster. Format: `^[A-Za-z0-9]{1,32}$`. Allowed
targets are the caster itself, any actor currently in the active encounter's
combatants, or any actor in the `GET /api/party` roster (union of all
invites) — anything else → `403 FORBIDDEN_RESOURCE`. Omitting the field
applies the buff to the caster, unchanged from the pre-target-buffs
behavior. Self-only buffs (e.g. Shield) never carry `targetable` on their
descriptor and are unaffected.

`attack`, `use`, and `cast` also accept an optional `targetTokenUuids`
(in-combat targeting, 2026-07-22): full REST-scoped token uuids
(`Scene.<id>.Token.<id>`, 1-12 entries, no duplicates — anything else →
`422 INVALID_INTENT`). Only meaningful for actions whose descriptor carries a
`targeting` block (`{ mode: "single" | "multiple", kind: "attack" | "save" |
"heal" }`); an untargetable action ignores the field. When present, the
gateway routes the action through one relay orchestration
(target → activity use → attack/save resolution → damage roll → apply
damage per target — Foundry owns all the rules) instead of the plain
`use-item`/`use-spell`/roll paths, and the response gains an `outcome` field
(see below). Requires a **currently active encounter**: with none running →
`409 CONFLICT`. Every target must appear in the active encounter's visible
roster (`GET /api/encounter`'s combatants, keyed by `tokenUuid`) — hidden
combatants never reach that roster and so can never be targeted; any target
outside it → `403 FORBIDDEN_RESOURCE`, checked *before* the relay call (no
slot/use is burned). This leg is side-effecting and **never retried**: a
relay timeout (408) — Foundry's orchestration may already have applied
damage — maps to `502 UPSTREAM` with the message "Timed out — check the
Foundry chat before retrying." rather than the usual null-result 200
tolerance other cast/use paths give a 408.

`move` (M19) relocates an item to a container or to carried; `containerId` is
the container item's `_id` (a bare item id, not an action id) or `null`
(carried). No roll or chat card. `pool` (M23, wod5e) rolls an
attribute/skill dice pool: `attribute`/`skill` (both optional) override the
descriptor's default pairing (ids match `Stat.id`, e.g. `attr.strength`,
`skill.athletics`, `disc.<key>`), and `modifier` (optional, integer,
`|modifier| <= 20`) folds in ad-hoc situational dice; the gateway computes
the formula from the actor's current dot ratings and hunger. A bare intent
(neither `attribute` nor `skill` given, e.g. tapping a stat/power row) uses
the descriptor's full default pairing. Once `attribute` is present, the
client is treated as fully specifying the pairing: omitting `skill` then
means "no second component" (attribute-only roll) — it does **not** fall
back to the descriptor's default skill. `rouse` (M23, wod5e) rolls a Rouse
check (`1d10cs>=6`) — no player-chosen params; hunger increment stays
manual (the app does not write it).

Semantics (server-enforced, in this order):
1. Actor owned by token → else `404`.
2. `actionId` present in the adapter's action list and `kind` matches →
   else `403 FORBIDDEN_RESOURCE`.
3. Payload valid (known kind, legal `slotLevel`…) → else `422 INVALID_INTENT`.
4. For `move`: target (`containerId`) must be a container-type item on the
   same actor, or `null` → else `422`. No cycles: an item cannot move into
   itself, and a container cannot move into its own (transitive) contents →
   else `422`.
5. For a targeted `attack`/`use`/`cast` (`targetTokenUuids` present and the
   adapter routes it through the targeted-use orchestration): an active
   encounter is required → else `409 CONFLICT`; every target must be in the
   active encounter's visible roster → else `403 FORBIDDEN_RESOURCE`. Both
   checks run before the relay call.
6. Execute via the relay (Foundry rolls, posts chat cards as the character,
   consumes slots/uses itself), then:
   `200 { "result": { "total": 14, "formula": "1d20 + 5", "isCritical": false, "isFumble": false } | null, "outcome"?: TargetedUseResult, "sheet": SheetViewModel }`
   (`result` is null for actions without a roll, e.g. equip or move.
   `outcome` is present only for the targeted orchestration above — the
   per-target attack/save/damage detail
   (`{ attack: {...} | null, targets: [{ tokenUuid, name, outcome, save?,
   damage? }] }`); `result` still carries the attack roll total for the roll
   pill when `outcome.attack` is non-null.)

Shares the write rate limit with intents (30/min per token).

### `POST /api/actors/:id/items` (M23)
Create a player-authored custom item (e.g. a wod5e improvised weapon) on the
actor. Available only when the actor's adapter declares `buildCustomItem`
(mirrors the library-collection 404 pattern below).

Body:

```json
{ "name": "Sharpened Stake", "type": "weapon", "damage": 2, "description": "Found in the workshop." }
```

`damage` and `description` are optional; `damage` is only meaningful for
types the adapter's `customItems` entry flags `hasDamage: true`.

Semantics (server-enforced, in this order):
1. Shared write limiter (30/min per token) → else `429 RATE_LIMITED`.
2. Actor owned by token → else `404`. Actor's adapter has no
   `buildCustomItem` → also `404` (indistinguishable from "not yours" — do
   not leak which systems support custom items).
3. The adapter builds **and validates** the world-item payload from the raw
   client body — the adapter's field whitelist is the only thing that ever
   reaches Foundry; unknown/extra fields are silently dropped, never copied
   through. Invalid input (bad name/type/damage/description) → `422
   INVALID_INTENT`.
4. No embedded-create endpoint exists on the relay, so creation is a
   3-call chain: `create` a scratch **world** item from the adapter's
   payload → `give` it to the actor (copies it in with system data intact)
   → best-effort `delete` the scratch world item (a failed delete just
   leaves a harmless world item behind; it does not fail the request).
   Any of create/give timing out or failing → `502 UPSTREAM`.
5. Fresh sheet is returned: `200 { "sheet": SheetViewModel }`.

### `GET /api/actors/:id/events` (SSE)
`Content-Type: text/event-stream`. Events:

- `event: sheet` — `data: <SheetViewModel JSON>` whenever the actor changes
  in Foundry (GM edits, other devices, own writes).
- `event: ping` — every 25 s keep-alive.

On connect the current sheet is sent immediately as a `sheet` event.

### `GET /api/encounter`
Retrieve the active encounter state. Active means a combat exists with round >= 1.
→ `200 <EncounterView>` (the bare view — no wrapper object).

`EncounterView` shape. When no encounter is active the response is exactly
`{ "active": false }` — `round`, `turn` and `combatants` are omitted, not null:

```json
{
  "active": true,
  "round": number,
  "turn": { "combatantId": string | null },
  "combatants": [
    {
      "id": string,
      "actorId": string,      // omitted when the combatant has no linked actor
      "name": string,
      "img": string,           // omitted when the combatant has no image
      "initiative": number | null,
      "isPC": boolean,
      "defeated": boolean,
      "health": "healthy" | "wounded" | "bloodied" | "down",  // non-PCs only; omitted for PCs
      "hp": { "value": number, "max": number }                // PCs only; omitted for non-PCs
    }
  ]
}
```

Every combatant carries exactly one of `health` (non-PCs) or `hp` (PCs) — the
other key is omitted, never null. Combatants are sorted by initiative
(descending). Hidden combatants are omitted from the view.

**Privacy contract:** Exact NPC hit points never appear in any player payload. NPCs
carry only a `health` state indicator; PCs carry exact `hp` values. This contract
is enforced by the gateway.

### `GET /api/encounter/events` (SSE)
`Content-Type: text/event-stream`. Query param: `token=<invite token>` (required;
SSE cannot set `Authorization` headers).

Events:

- `event: encounter` — `data: <EncounterView JSON>` on initial connect and on
  every combat state change (round, turn, combatant HP/status).
- `event: ping` — every 25 s keep-alive.

On connect the current encounter view is sent immediately as an `encounter` event.

### `POST /api/encounter/combatants/:id/hp`
Apply a delta to a combatant's HP (damage or healing). Temporary hit points are
consumed before the pool, per D&D 5e rules.

Body:

```json
{ "kind": "delta", "amount": -7 }
```

Semantics (server-enforced, in this order):
1. Shared write limiter (30/min per token) → else `429 RATE_LIMITED`.
2. Combat must be active (round >= 1) → else `409 CONFLICT` (regardless of
   whether `:id` names a real combatant).
3. Combatant must exist in the active encounter → else `404 NOT_FOUND`.
4. Combatant must have a linked actor; if not (broken reference) → `422 INVALID_INTENT`.
5. Payload must validate: `kind` must be `"delta"`, `amount` a finite, non-zero
   number (`amount: 0` is rejected) → else `422 INVALID_INTENT`.
6. Damage/healing is relayed to Foundry, temp HP consumed first (D&D 5e rule), then
   the fresh encounter view is returned:
   `200 { "encounter": EncounterView }` (this endpoint wraps the view; the GET does not).

Additional errors:
- `502 UPSTREAM` — relay timeout or unreachable.

### `POST /api/encounter/turn/end`
Advance the combat turn. No body.

Semantics (server-enforced, in this order):
1. Shared write limiter (30/min per token) → else `429 RATE_LIMITED`.
2. An encounter must be active with a resolvable acting combatant → else
   `409 CONFLICT` ("no active encounter").
3. Only the acting combatant's own player may end their turn — the GM keeps
   NPC turns in Foundry itself — else `403 FORBIDDEN_RESOURCE` ("not your
   turn").
4. The relay re-checks (script-side race guard) that the expected combatant
   is still acting before calling `combat.nextTurn()`. If a concurrent
   change already advanced/altered the turn, it refuses → `409 CONFLICT`
   ("turn already advanced").
5. On success: `200 { "ok": true }`.

Additional errors:
- `502 UPSTREAM` — relay timeout or unreachable (bounded).

### `GET /healthz` (no auth)
→ `200 { "ok": true, "relay": "connected" | "disconnected" }`

## Error envelope

```json
{ "error": { "code": "UNAUTHORIZED|FORBIDDEN_RESOURCE|INVALID_INTENT|CONFLICT|RATE_LIMITED|UPSTREAM|NOT_FOUND", "message": "…" } }
```

`UPSTREAM` (502) = relay unreachable/errored; the gateway never exposes relay
response bodies verbatim.

## Gateway configuration (env)

| var | meaning |
|---|---|
| `PORT` | listen port (default 8090) |
| `RELAY_URL` | e.g. `http://relay:3010` |
| `RELAY_API_KEY` | scoped relay key (entity read/write, search, events) |
| `RELAY_CLIENT_ID` | Foundry world client id (`fvtt_…`) |
| `PLAYERS_FILE` | path to `players.yaml` |
| `ADMIN_PASSWORD` | optional; enables the `/api/admin/*` surface (M18). Unset or empty → those routes all answer `404`, indistinguishable from routes that don't exist |

## Admin endpoints (M18)

Separate credential from player tokens: `Authorization: Bearer <ADMIN_PASSWORD>`,
checked with a timing-safe comparison. A player's invite token does **not**
work on these routes (and `ADMIN_PASSWORD` does not work on player routes) —
both directions answer `401`. When `ADMIN_PASSWORD` is unset, every route
below answers `404` regardless of credential.

`players.yaml` is gateway-managed once these routes are in use: writes are
atomic (temp file + rename) and the file carries a `# Managed by the
gateway` header. Hand edits are still picked up live (~1s, file watcher, no
restart) but comments do not survive a console-driven rewrite.

### `GET /api/admin/players`
→ `200 { "players": [ { "name": "Anna", "gm": true, "actors": [ { "id": "kbXH9…", "name": "Sariel" } ] } ] }`

Never returns token hashes. Actor names are resolved best-effort via the
relay; an actor id that can't be resolved (e.g. deleted in Foundry) is
returned bare — `{ "id": "ghost-id" }`, no `name` key.

### `POST /api/admin/players`
Body: `{ "name": string, "actorIds": string[] }`.
→ `201 { "token": string, "player": { "name": string, "actorIds": string[], "gm": boolean } }`

The plaintext `token` is the invite/join token — it exists **only in this
response** (show-once: display it and its QR once, then discard; only its
sha256 hash is ever persisted). Errors: `422` on a missing/empty `name`,
empty/missing `actorIds`, or any empty-string actor id; `409` on a duplicate
name (case-insensitive).

### `POST /api/admin/players/:name/rotate`
→ `200 { "token": string }` | `404` (unknown name)

Replaces the player's token hash; the old token stops working immediately.
Same show-once semantics as create — this is the only time the new token is
ever visible.

### `DELETE /api/admin/players/:name`
→ `204` | `404` (unknown name)

Removes the entry; the player's token (and any join link built from it)
stops working immediately.

### `GET /api/admin/actors?q=…`
Search-driven picker for the **New player** actor field (deviation from the
original spec, which implied a full world listing — the relay only exposes
discovery via search, mirroring the M13 library UX). World character actors
only; compendium hits are filtered out.
→ `200 { "actors": [ { "id": string, "name": string, "img"?: string } ] }`

Empty/missing `q` → `200 { "actors": [] }` without querying the relay.
