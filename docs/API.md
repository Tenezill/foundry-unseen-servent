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
for a detail view — the client sanitizes it).

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

Semantics (server-enforced, in this order):
1. Actor owned by token → else `404`.
2. `actionId` present in the adapter's action list and `kind` matches →
   else `403 FORBIDDEN_RESOURCE`.
3. Payload valid (known kind, legal `slotLevel`…) → else `422 INVALID_INTENT`.
4. Execute via the relay (Foundry rolls, posts chat cards as the character,
   consumes slots/uses itself), then:
   `200 { "result": { "total": 14, "formula": "1d20 + 5", "isCritical": false, "isFumble": false } | null, "sheet": SheetViewModel }`
   (`result` is null for actions without a roll, e.g. equip.)

Shares the write rate limit with intents (30/min per token).

### `GET /api/actors/:id/events` (SSE)
`Content-Type: text/event-stream`. Events:

- `event: sheet` — `data: <SheetViewModel JSON>` whenever the actor changes
  in Foundry (GM edits, other devices, own writes).
- `event: ping` — every 25 s keep-alive.

On connect the current sheet is sent immediately as a `sheet` event.

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
