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
