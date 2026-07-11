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
{ "kind": "use",    "actionId": "feature.p0Wm1.use" }
{ "kind": "equip",  "actionId": "item.X3ab9.equip", "equipped": false }
{ "kind": "move",   "actionId": "item.X3ab9.move", "containerId": "wYUZWMKa6FntpIvv" }
{ "kind": "move",   "actionId": "item.X3ab9.move", "containerId": null }
{ "kind": "rest",   "actionId": "rest.short" }
{ "kind": "rest",   "actionId": "rest.long" }
{ "kind": "deathsave",       "actionId": "deathsave.roll" }
{ "kind": "endconcentration","actionId": "concentration.end" }
```

The M8 actor-command kinds (`rest`/`deathsave`/`endconcentration`) take no
item target; the gateway runs the matching relay command
(`short-rest`/`long-rest`/`death-save`/`break-concentration`) and returns the
fresh sheet (`result` null — these post their own chat card). `cast` no longer
takes `slotLevel`: the bridge casts at base level only (see M6 known limits).
`move` (M19) relocates an item to a container or to carried; `containerId` is
the container item's `_id` (a bare item id, not an action id) or `null`
(carried). No roll or chat card.

Semantics (server-enforced, in this order):
1. Actor owned by token → else `404`.
2. `actionId` present in the adapter's action list and `kind` matches →
   else `403 FORBIDDEN_RESOURCE`.
3. Payload valid (known kind, legal `slotLevel`…) → else `422 INVALID_INTENT`.
4. For `move`: target (`containerId`) must be a container-type item on the
   same actor, or `null` → else `422`. No cycles: an item cannot move into
   itself, and a container cannot move into its own (transitive) contents →
   else `422`.
5. Execute via the relay (Foundry rolls, posts chat cards as the character,
   consumes slots/uses itself), then:
   `200 { "result": { "total": 14, "formula": "1d20 + 5", "isCritical": false, "isFumble": false } | null, "sheet": SheetViewModel }`
   (`result` is null for actions without a roll, e.g. equip or move.)

Shares the write rate limit with intents (30/min per token).

### `GET /api/actors/:id/events` (SSE)
`Content-Type: text/event-stream`. Events:

- `event: sheet` — `data: <SheetViewModel JSON>` whenever the actor changes
  in Foundry (GM edits, other devices, own writes).
- `event: ping` — every 25 s keep-alive.

On connect the current sheet is sent immediately as a `sheet` event.

### `GET /api/encounter`
Retrieve the active encounter state. Active means a combat exists with round >= 1.
→ `200 { "encounter": EncounterView }`

`EncounterView` shape:

```json
{
  "active": boolean,
  "round": number | null,
  "turn": { "combatantId": string | null } | null,
  "combatants": [
    {
      "id": string,
      "actorId": string | null,
      "name": string,
      "img": string | null,
      "initiative": number | null,
      "isPC": boolean,
      "defeated": boolean,
      "health": "healthy" | "wounded" | "bloodied" | "down" | null,
      "hp": { "value": number, "max": number } | null
    }
  ]
}
```

Combatants are sorted by initiative (descending). Hidden combatants are omitted from the view.

**Privacy contract:** Exact NPC hit points never appear in any player payload. NPCs
carry only a `health` state indicator; PCs carry exact `hp` values. This contract
is enforced by the relay and gateway.

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
1. Combatant must exist → else `404 NOT_FOUND`.
2. Combat must be active (round >= 1) → else `409 CONFLICT`.
3. Payload must validate (`kind` known, `amount` finite) → else `422 INVALID_INTENT`.
4. Combatant must have a linked actor; if not (broken reference) → `422 INVALID_INTENT`.
5. Damage/healing is relayed to Foundry, temp HP consumed first (D&D 5e rule), then
   the fresh encounter view is returned:
   `200 { "encounter": EncounterView }`

Rate limit: shared write limiter (30/min per token) → `429 RATE_LIMITED`.

Additional errors:
- `502 UPSTREAM` — relay timeout or unreachable.

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
