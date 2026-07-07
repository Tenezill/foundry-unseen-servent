# M0 findings — bridge spike (2026-07-07, live-verified)

Stack: Foundry v13.351 (felddy image) + dnd5e 5.3.3 + foundry-rest-api module 3.4.1
+ self-hosted relay 3.4.1, all via `stack/docker-compose.dev.yml`. World
`companion-test` ("Companion Test"), GM + players Anna/Ben, actors
`Actor.zteTG9PZZ6XQpQtK` (Randal, Fighter 5, owned by Anna) and
`Actor.pTvtx5dm2AuYqeX2` (Akra, Cleric 5, owned by Ben).

## 1. Read/write endpoints (verified working)

The relay is the **v3 Go rewrite**; auth uses a **scoped API key** in the
`x-api-key` header; every request carries `clientId` (ours:
`fvtt_6c7551678c979b45`). Account + key creation is fully scriptable:
`POST /auth/register` → `POST /auth/api-keys` (scopes:
`entity:read, entity:write, search, events:subscribe, clients:read, dnd5e`).

**Read** — `GET /get?clientId=…&uuid=Actor.<id>`
→ `200 {"type":"entity-result","requestId":"…","uuid":"Actor.<id>","data":{<full document>}}`.
`data` includes `_id`, full `items` array, and **derived** values where dnd5e
computes them into the document (e.g. `abilities.str.max: 20`, hp), BUT
`skills.*.total` came back empty in our capture → the adapter's fallback
computation (ability mod + proficiency) is required, not optional.

**Write** — `PUT /update?clientId=…&uuid=Actor.<id>` with body
`{"data":{"system.attributes.hp.value":28}}` → `200 {"type":"update-result",…}`
in **477 ms**; the change was visible in the connected Foundry client
immediately (`game.actors.get(...).system.attributes.hp.value === 28`).
Dot-notation paths are passed straight to `Document.update()`. Embedded items
are addressable as `Actor.<actorId>.Item.<itemId>` uuids.

**Captured fixtures**: `docs/captured/martial-raw.json` (66 KB),
`docs/captured/caster-raw.json` (121 KB) — the verbatim `/get` responses;
`packages/adapter-dnd5e/test/fixtures/` must be reconciled to `data` from these.

## 2. Logged-in client requirement — YES

The module runs client-side (browser). With the GM tab closed the relay
reports `isOnline: false` and `/get` returns **404** (verified). One full-GM
(role 4) browser connection holds the world's relay slot.

**Smallest headless setup:** the relay image itself ships Chrome + Xvfb +
Puppeteer and exposes a managed headless GM session:
`POST /session-handshake` → `POST /start-session` (relay logs into Foundry as
a GM user and keeps the world online). For dev we keep a browser tab open;
production (M5) uses the relay session API. No third container needed.

## 3. Push to API consumers — YES, with one gotcha

- `GET /hooks/subscribe?clientId=…&hooks=updateActor` (SSE) **works**:
  `event: updateActor` frames carrying the full updated actor document in
  `data.args[0]`. This is the gateway's live feed — ONE subscription for the
  whole world, filter by actor `_id`.
- `GET /actor/subscribe?actorUuid=…` connects (`event: connected` +
  keepalives) but delivered **no events** on actor updates in module/relay
  3.4.1 → do not use; re-test on future upgrades.
- A consumer WebSocket (`/ws/api`) also exists; SSE is sufficient for v1.
- Polling fallback stays in the gateway config (`LIVE_POLL_MS`) as a safety
  net, but push is the default. No 2–3 s polling loop needed.

## 4. Version pins → `VERSIONS.md`

| component | pin |
|---|---|
| Foundry | `felddy/foundryvtt:13.351.0` |
| dnd5e | 5.3.3 (`release-5.3.3` zip into `Data/systems/dnd5e`) |
| foundry-rest-api module | 3.4.1 (release zip into `Data/modules/foundry-rest-api`) |
| relay | `threehats/foundryvtt-rest-api-relay:3.4.1` |

## Gotchas learned (cost real time)

1. **Relay auth rate limit** (~20 req/15 min/IP on `/auth/*`, in-memory): the
   module's pair-status poll consumes it fast — pair + approve within ~15 s,
   or restart the relay container to reset the limiter before pairing.
2. The module's "approve in browser" link points at the **public**
   foundryrestapi.com even when `wsRelayUrl` is local — always open
   `http://localhost:3010/pair/<CODE>` manually.
3. Docker Compose interpolates `$` in `.env` (swallows password chars) — the
   compose file uses `env_file: {path: .env, format: raw}`.
4. dnd5e **5.x schema** deltas vs older docs: class hit dice =
   `system.hd.{denomination,spent}` (not `hitDiceUsed`); item uses =
   `system.uses.{spent,max}` with `max` a *formula string*; spell
   preparation = `system.method` (+ `system.prepared`), not
   `preparation.mode`; relay `/get` wraps the document in `data`.
5. Relay module pairing stores a **connection token** per browser
   (localStorage), so the world reconnects automatically on reload.

## Gate decision

No blocker → **Option A + gateway confirmed**; Option C fallback not needed.
