# Token movement v1 — live-check findings (2026-07-21)

Stack: relay 3.4.1 (Go binary) + Foundry 14.364 + dnd5e, dev compose.
Verified end-to-end via `apps/gateway/e2e/live-movement.mjs` — **22/22 checks**
(view shape, ownership 404-never-403, out-of-range 422, occupied 409,
non-integer 422, real move + fresh-GET confirm + restore, animated in Foundry).

## 1. Module actionTypes ≠ relay HTTP routes (the big one)

`module.js` (the Foundry-side bundle) registers socket handlers by actionType,
but the Go relay has its OWN HTTP route table — the "HTTP path = actionType"
convention does NOT hold for the scene/canvas family:

| actionType (module) | HTTP route (relay 3.4.1) | scope |
|---|---|---|
| `get-scene` | **`GET /scene`** (`?active=true` etc.; bare → 400) | `scene:read` |
| `get-canvas-documents` | **none — route does not exist** | — |
| `move-token` | `POST /move-token` (same name) | `canvas:write` |
| `switch-scene` | `POST /switch-scene` | `scene:write` |
| `create-scene` | none — but generic `POST /create` `entityType:'Scene'` works, **and accepts embedded `tokens` inline** | `entity:write` |

A missing route answers with the Go router's plain-text `404 page not found`;
an existing route always answers JSON (`{"error":…}`). Scope errors are
`403 {"error":"API key lacks required scope: …"}` and fire only when the
route exists — useful for probing.

Consequence baked into the code: `GET /scene` returns `Scene.toObject()`
**including the embedded `tokens` array**, so movement needs one scene call,
not two (`getCanvasDocuments` was deleted; `RelayScene.tokens` carries them).

## 2. dnd5e 5.x walk speed is derived, not source

Real actors (Randal, Akra) carry **no `system.attributes.movement` in source
data** — `GET /get` (toObject) yields nothing and speed computed from it is 0.
The live value comes from the derived-data endpoint:
`GET /dnd5e/get-actor-details?details=["stats"]` → `stats.speed` (reads the
prepared `system.attributes.movement.walk` off the in-memory actor). The
gateway's movement context now uses that leg (same mechanism as the adapter
enrich path).

## 3. Relay key scopes

Movement requires `scene:read` + `canvas:write` on the gateway's relay key —
added to the canonical list in `apps/bootstrap/src/scopes.ts`. **Existing
minted keys (dev `apps/gateway/.env`, prod) predate this and will 403 on the
movement endpoints until re-minted** on the pairing-owner account
(`/auth/login` + `/auth/api-keys`, creds in `stack/.env`).

## 4. Headless GM session behavior

- `POST /session-handshake` (headers `x-api-key`/`x-foundry-url`/`x-username`,
  key needs `session:manage`) + `POST /start-session` (`handshakeToken` +
  RSA-OAEP/SHA-256-encrypted `{password, nonce}`) brings the world online
  without a human GM tab — this is how the live check ran.
- The session **expires after roughly 10 minutes** (handshake `expires` field)
  and is not renewed by itself; the quickstart bootstrap re-attempts on a loop
  (`SESSION_BACKOFF_MS`), the dev stack has nothing doing that. Long-running
  live checks must re-handshake.
- If Foundry thinks the GM user is still logged in (stale socket),
  `/start-session` 408s with "already logged in" — a Foundry container
  restart clears it.
- `execute-js` remains disabled in the Companion Test world's module settings
  (fine — nothing in movement needs it).

## 5. World state left behind

Scene **"Movement Live Check"** (`76dwvLiGQx21hJmp`, 20×14 squares, 100px/5ft
grid, no walls, vision off) is now the active scene of the Companion Test
world, with Randal (5,5) and Akra (7,5) linked-actor tokens — kept
deliberately as the standing fixture for movement testing (and for trying the
PWA Move sheet by hand). Delete via `DELETE /delete?uuid=Scene.76dwvLiGQx21hJmp`
if unwanted. The `__route_probe__` scene created during probing was deleted.
